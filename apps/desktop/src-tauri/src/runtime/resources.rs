//! 应用进程资源治理策略与平台适配接口。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

pub const MIN_BACKGROUND_DELAY_MS: u64 = 4_000;
pub const TRIM_COOLDOWN_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub parent_pid: u32,
    pub creation_time_100ns: u64,
}

impl ProcessIdentity {
    pub fn has_creation_time(self, creation_time_100ns: u64) -> bool {
        self.creation_time_100ns == creation_time_100ns
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedProcessTree {
    identities: Vec<ProcessIdentity>,
}

impl VerifiedProcessTree {
    pub fn from_observed(root: ProcessIdentity, observed: Vec<ProcessIdentity>) -> Self {
        let mut identities = vec![root];
        let mut verified_by_pid = HashMap::from([(root.pid, root)]);
        loop {
            let mut changed = false;
            for identity in &observed {
                if verified_by_pid.contains_key(&identity.pid) {
                    continue;
                }
                let Some(parent) = verified_by_pid.get(&identity.parent_pid) else {
                    continue;
                };
                // PROCESSENTRY32W 只保存 parent PID；若该 PID 已复用，新进程的创建时间会
                // 晚于旧 child。只有 child 不早于当前观测到的 parent identity 才能继续父链。
                if identity.creation_time_100ns < parent.creation_time_100ns {
                    continue;
                }
                identities.push(*identity);
                verified_by_pid.insert(identity.pid, *identity);
                changed = true;
            }
            if !changed {
                break;
            }
        }
        identities.sort_unstable_by_key(|identity| (identity.pid != root.pid, identity.pid));
        Self { identities }
    }

    pub fn identities(&self) -> &[ProcessIdentity] {
        &self.identities
    }
}

/// 将两次 ToolHelp 枚举之间保持相同父 PID 的进程身份留下。
///
/// ToolHelp 只提供 PID 与 parent PID，而创建时间需要另一次打开进程读取。若 PID 在两者
/// 之间被复用，第一次枚举得到的 parent PID 不能再和新进程的创建时间拼成 identity。
/// 因此必须在读取创建时间后再次确认该 PID/parent PID 元组未变化。
fn reconcile_process_identities_after_parent_confirmation(
    root: ProcessIdentity,
    parents_before: Vec<(u32, u32)>,
    parents_after: Vec<(u32, u32)>,
    observed_identities: Vec<ProcessIdentity>,
) -> Vec<ProcessIdentity> {
    let parents_before: HashMap<_, _> = parents_before.into_iter().collect();
    let parents_after: HashMap<_, _> = parents_after.into_iter().collect();
    let mut reconciled = vec![root];

    for identity in observed_identities {
        if identity.pid == root.pid {
            continue;
        }
        let tuple_is_stable = parents_before.get(&identity.pid) == Some(&identity.parent_pid)
            && parents_after.get(&identity.pid) == Some(&identity.parent_pid);
        if tuple_is_stable {
            reconciled.push(identity);
        }
    }

    reconciled
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum WindowActivity {
    Foreground,
    Visible,
    Hidden { since_ms: u64 },
    Minimized { since_ms: u64 },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ProcessMemoryCapability {
    Available,
    Unsupported { reason: String },
    Disabled { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedProcessMemory {
    #[serde(flatten)]
    pub identity: ProcessIdentity,
    pub working_set_bytes: u64,
    pub peak_working_set_bytes: u64,
    pub private_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemorySnapshot {
    /// 保留旧字段名称；现在表示已验证应用进程树的根 PID 与聚合值。
    pub pid: u32,
    pub working_set_bytes: u64,
    pub private_bytes: Option<u64>,
    pub peak_working_set_bytes: u64,
    pub processes: Vec<VerifiedProcessMemory>,
    pub process_failures: Vec<ProcessMemoryError>,
}

impl ProcessMemorySnapshot {
    pub fn from_verified_processes(
        root_pid: u32,
        processes: Vec<VerifiedProcessMemory>,
        process_failures: Vec<ProcessMemoryError>,
    ) -> Self {
        let working_set_bytes = processes.iter().fold(0_u64, |total, item| {
            total.saturating_add(item.working_set_bytes)
        });
        let peak_working_set_bytes = processes.iter().fold(0_u64, |total, item| {
            total.saturating_add(item.peak_working_set_bytes)
        });
        let private_bytes = processes.iter().try_fold(0_u64, |total, item| {
            item.private_bytes.map(|bytes| total.saturating_add(bytes))
        });
        Self {
            pid: root_pid,
            working_set_bytes,
            private_bytes,
            peak_working_set_bytes,
            processes,
            process_failures,
        }
    }
}

#[cfg(test)]
fn single_process_memory_snapshot(
    pid: u32,
    working_set_bytes: u64,
    peak_working_set_bytes: u64,
    private_bytes: Option<u64>,
) -> ProcessMemorySnapshot {
    ProcessMemorySnapshot::from_verified_processes(
        pid,
        vec![VerifiedProcessMemory {
            identity: ProcessIdentity {
                pid,
                parent_pid: 0,
                creation_time_100ns: 0,
            },
            working_set_bytes,
            peak_working_set_bytes,
            private_bytes,
        }],
        Vec::new(),
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessMemoryOperation {
    Enumerate,
    Open,
    VerifyIdentity,
    Snapshot,
    Trim,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryError {
    pub pid: Option<u32>,
    pub operation: ProcessMemoryOperation,
    pub message: String,
    pub os_code: Option<i32>,
}

impl fmt::Display for ProcessMemoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?} 失败：{}", self.operation, self.message)
    }
}

impl std::error::Error for ProcessMemoryError {}

pub trait ProcessMemoryAdapter: Send + Sync {
    fn capability(&self) -> ProcessMemoryCapability;

    fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError>;

    fn trim_current_process(&self) -> Result<(), ProcessMemoryError>;

    fn snapshot_verified_process_tree(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
        self.snapshot_current_process()
    }

    fn trim_verified_process_tree(&self, identities: &[ProcessIdentity]) -> Vec<ProcessTrimResult> {
        let pid = identities.first().map(|identity| identity.pid).unwrap_or(0);
        match self.trim_current_process() {
            Ok(()) => vec![ProcessTrimResult::Trimmed { pid }],
            Err(error) => vec![ProcessTrimResult::Failed { pid, error }],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum ProcessTrimSkipReason {
    Exited,
    IdentityChanged {
        expected_creation_time_100ns: u64,
        actual_creation_time_100ns: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ProcessTrimResult {
    Trimmed {
        pid: u32,
    },
    Skipped {
        pid: u32,
        reason: ProcessTrimSkipReason,
    },
    Failed {
        pid: u32,
        error: ProcessMemoryError,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TrimSkipReason {
    Foreground,
    Visible,
    BackgroundDelay { remaining_ms: u64 },
    Cooldown { remaining_ms: u64 },
    InFlight,
    Unsupported { reason: String },
    Disabled { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum TrimOutcome {
    Skipped {
        reason: TrimSkipReason,
    },
    Completed {
        before: ProcessMemorySnapshot,
        after: ProcessMemorySnapshot,
        reclaimed_working_set_bytes: u64,
        processes: Vec<ProcessTrimResult>,
    },
    Failed {
        stage: TrimFailureStage,
        before: Option<ProcessMemorySnapshot>,
        error: ProcessMemoryError,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrimFailureStage {
    SnapshotBefore,
    Trim,
    SnapshotAfter,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemPurgePolicy {
    #[default]
    Disabled,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SystemPurgeOutcome {
    Skipped {
        policy: SystemPurgePolicy,
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceGovernanceSnapshot {
    pub min_background_delay_ms: u64,
    pub trim_cooldown_ms: u64,
    pub trim_in_flight: bool,
    pub last_attempt_ms: Option<u64>,
    pub system_purge_policy: SystemPurgePolicy,
}

#[derive(Debug)]
pub struct ResourceGovernor {
    last_attempt_ms: Mutex<Option<u64>>,
    trim_in_flight: AtomicBool,
    system_purge_policy: SystemPurgePolicy,
}

impl Default for ResourceGovernor {
    fn default() -> Self {
        Self {
            last_attempt_ms: Mutex::new(None),
            trim_in_flight: AtomicBool::new(false),
            system_purge_policy: SystemPurgePolicy::default(),
        }
    }
}

struct InFlightReset<'a> {
    flag: &'a AtomicBool,
}

impl Drop for InFlightReset<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

impl ResourceGovernor {
    pub fn with_system_purge_policy(system_purge_policy: SystemPurgePolicy) -> Self {
        Self {
            system_purge_policy,
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> ResourceGovernanceSnapshot {
        ResourceGovernanceSnapshot {
            min_background_delay_ms: MIN_BACKGROUND_DELAY_MS,
            trim_cooldown_ms: TRIM_COOLDOWN_MS,
            trim_in_flight: self.trim_in_flight.load(Ordering::Acquire),
            last_attempt_ms: *self
                .last_attempt_ms
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            system_purge_policy: self.system_purge_policy,
        }
    }

    /// 系统级 purge 在 M5 中不执行提权或 helper；调用始终返回明确策略。
    pub fn request_system_purge(&self) -> SystemPurgeOutcome {
        let reason = match self.system_purge_policy {
            SystemPurgePolicy::Disabled => "系统级内存清理默认禁用".to_string(),
            SystemPurgePolicy::Unsupported => {
                "当前平台不提供安全、非提权的系统级内存清理".to_string()
            }
        };
        SystemPurgeOutcome::Skipped {
            policy: self.system_purge_policy,
            reason,
        }
    }

    pub fn trim_working_set<A: ProcessMemoryAdapter + ?Sized>(
        &self,
        activity: WindowActivity,
        now_ms: u64,
        adapter: &A,
    ) -> TrimOutcome {
        self.trim_working_set_with_force(activity, now_ms, false, adapter)
    }

    pub fn trim_working_set_manual<A: ProcessMemoryAdapter + ?Sized>(
        &self,
        activity: WindowActivity,
        now_ms: u64,
        force: bool,
        adapter: &A,
    ) -> TrimOutcome {
        self.trim_working_set_with_force(activity, now_ms, force, adapter)
    }

    fn trim_working_set_with_force<A: ProcessMemoryAdapter + ?Sized>(
        &self,
        activity: WindowActivity,
        now_ms: u64,
        force: bool,
        adapter: &A,
    ) -> TrimOutcome {
        if !force {
            match activity {
                WindowActivity::Foreground => {
                    return TrimOutcome::Skipped {
                        reason: TrimSkipReason::Foreground,
                    };
                }
                WindowActivity::Visible => {
                    return TrimOutcome::Skipped {
                        reason: TrimSkipReason::Visible,
                    };
                }
                WindowActivity::Hidden { since_ms } | WindowActivity::Minimized { since_ms } => {
                    let elapsed_ms = now_ms.saturating_sub(since_ms);
                    if elapsed_ms < MIN_BACKGROUND_DELAY_MS {
                        return TrimOutcome::Skipped {
                            reason: TrimSkipReason::BackgroundDelay {
                                remaining_ms: MIN_BACKGROUND_DELAY_MS - elapsed_ms,
                            },
                        };
                    }
                }
            }
        }

        if self
            .trim_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return TrimOutcome::Skipped {
                reason: TrimSkipReason::InFlight,
            };
        }
        let _in_flight_reset = InFlightReset {
            flag: &self.trim_in_flight,
        };

        if !force {
            let last_attempt_ms = self
                .last_attempt_ms
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(last_attempt_ms) = *last_attempt_ms {
                let elapsed_ms = now_ms.saturating_sub(last_attempt_ms);
                if elapsed_ms < TRIM_COOLDOWN_MS {
                    return TrimOutcome::Skipped {
                        reason: TrimSkipReason::Cooldown {
                            remaining_ms: TRIM_COOLDOWN_MS - elapsed_ms,
                        },
                    };
                }
            }
        }

        match adapter.capability() {
            ProcessMemoryCapability::Available => {}
            ProcessMemoryCapability::Unsupported { reason } => {
                return TrimOutcome::Skipped {
                    reason: TrimSkipReason::Unsupported { reason },
                };
            }
            ProcessMemoryCapability::Disabled { reason } => {
                return TrimOutcome::Skipped {
                    reason: TrimSkipReason::Disabled { reason },
                };
            }
        }

        *self
            .last_attempt_ms
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(now_ms);

        let before = match adapter.snapshot_verified_process_tree() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return TrimOutcome::Failed {
                    stage: TrimFailureStage::SnapshotBefore,
                    before: None,
                    error,
                };
            }
        };
        let identities: Vec<_> = before
            .processes
            .iter()
            .map(|process| process.identity)
            .collect();
        let processes = adapter.trim_verified_process_tree(&identities);
        let after = match adapter.snapshot_verified_process_tree() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return TrimOutcome::Failed {
                    stage: TrimFailureStage::SnapshotAfter,
                    before: Some(before),
                    error,
                };
            }
        };
        TrimOutcome::Completed {
            reclaimed_working_set_bytes: before
                .working_set_bytes
                .saturating_sub(after.working_set_bytes),
            before,
            after,
            processes,
        }
    }
}

#[derive(Debug, Default)]
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub struct UnsupportedProcessMemoryAdapter;

impl ProcessMemoryAdapter for UnsupportedProcessMemoryAdapter {
    fn capability(&self) -> ProcessMemoryCapability {
        ProcessMemoryCapability::Unsupported {
            reason: "当前平台不支持应用工作集整理".to_string(),
        }
    }

    fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
        Err(ProcessMemoryError {
            pid: None,
            operation: ProcessMemoryOperation::Snapshot,
            message: "当前平台不支持应用工作集快照".to_string(),
            os_code: None,
        })
    }

    fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
        Err(ProcessMemoryError {
            pid: None,
            operation: ProcessMemoryOperation::Trim,
            message: "当前平台不支持应用工作集整理".to_string(),
            os_code: None,
        })
    }
}

#[derive(Debug, Default)]
pub struct WindowsProcessMemoryAdapter;

#[cfg(target_os = "windows")]
struct OwnedWindowsHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for OwnedWindowsHandle {
    fn drop(&mut self) {
        // SAFETY: 该 wrapper 只接管 OpenProcess/CreateToolhelp32Snapshot 返回的真实句柄，
        // 且没有 Clone，实现确保 CloseHandle 恰好调用一次。
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
impl ProcessMemoryAdapter for WindowsProcessMemoryAdapter {
    fn capability(&self) -> ProcessMemoryCapability {
        ProcessMemoryCapability::Available
    }

    fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
        self.snapshot_verified_process_tree()
    }

    fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
        let snapshot = self.snapshot_verified_process_tree()?;
        let Some(root) = snapshot.processes.first() else {
            return Err(ProcessMemoryError {
                pid: Some(snapshot.pid),
                operation: ProcessMemoryOperation::Snapshot,
                message: "应用根进程快照为空".to_string(),
                os_code: None,
            });
        };
        match windows_trim_verified_process(root.identity) {
            ProcessTrimResult::Trimmed { .. } => Ok(()),
            ProcessTrimResult::Skipped { pid, reason } => Err(ProcessMemoryError {
                pid: Some(pid),
                operation: ProcessMemoryOperation::VerifyIdentity,
                message: format!("进程 identity 已变化：{reason:?}"),
                os_code: None,
            }),
            ProcessTrimResult::Failed { error, .. } => Err(error),
        }
    }

    fn snapshot_verified_process_tree(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
        windows_snapshot_verified_process_tree()
    }

    fn trim_verified_process_tree(&self, identities: &[ProcessIdentity]) -> Vec<ProcessTrimResult> {
        identities
            .iter()
            .copied()
            .map(windows_trim_verified_process)
            .collect()
    }
}

#[cfg(not(target_os = "windows"))]
impl ProcessMemoryAdapter for WindowsProcessMemoryAdapter {
    fn capability(&self) -> ProcessMemoryCapability {
        UnsupportedProcessMemoryAdapter.capability()
    }

    fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
        UnsupportedProcessMemoryAdapter.snapshot_current_process()
    }

    fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
        UnsupportedProcessMemoryAdapter.trim_current_process()
    }
}

#[cfg(target_os = "windows")]
fn windows_snapshot_verified_process_tree() -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
    let tree = windows_discover_verified_process_tree()?;
    let root_pid = tree
        .identities()
        .first()
        .map(|identity| identity.pid)
        .unwrap_or_else(std::process::id);
    let mut processes = Vec::with_capacity(tree.identities().len());
    let mut process_failures = Vec::new();
    for identity in tree.identities() {
        match windows_snapshot_verified_process(*identity) {
            Ok(snapshot) => processes.push(snapshot),
            Err(error) if identity.pid == root_pid => return Err(error),
            Err(error) => process_failures.push(error),
        }
    }
    Ok(ProcessMemorySnapshot::from_verified_processes(
        root_pid,
        processes,
        process_failures,
    ))
}

#[cfg(target_os = "windows")]
fn windows_discover_verified_process_tree() -> Result<VerifiedProcessTree, ProcessMemoryError> {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    let observed_parents = windows_enumerate_process_parents()?;

    // SAFETY: 该函数无参数且只返回当前进程 ID。
    let root_pid = unsafe { GetCurrentProcessId() };
    let root_parent_pid = observed_parents
        .iter()
        .find_map(|(pid, parent_pid)| (*pid == root_pid).then_some(*parent_pid))
        .unwrap_or(0);
    let root_creation_time = windows_query_creation_time(root_pid)?;
    let root = ProcessIdentity {
        pid: root_pid,
        parent_pid: root_parent_pid,
        creation_time_100ns: root_creation_time,
    };

    // 先按 parent PID 收窄潜在后代，再读取创建时间交给 VerifiedProcessTree 做复用防护。
    // 即便这里因 PID reuse 多包含了候选，也只会读取 identity，不会对其执行 trim。
    let mut potential_pids = HashSet::from([root_pid]);
    loop {
        let mut changed = false;
        for (pid, parent_pid) in &observed_parents {
            if !potential_pids.contains(pid) && potential_pids.contains(parent_pid) {
                potential_pids.insert(*pid);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut observed = Vec::new();
    for (pid, parent_pid) in &observed_parents {
        if *pid == root_pid || !potential_pids.contains(pid) {
            continue;
        }
        if let Ok(creation_time_100ns) = windows_query_creation_time(*pid) {
            observed.push(ProcessIdentity {
                pid: *pid,
                parent_pid: *parent_pid,
                creation_time_100ns,
            });
        }
    }
    // 创建时间读取与第一次 ToolHelp 枚举不是原子操作。重新枚举并要求 PID/parent PID
    // 元组保持不变，避免将已经复用的 PID 误接到旧进程树上。
    let confirmed_parents = windows_enumerate_process_parents()?;
    let observed = reconcile_process_identities_after_parent_confirmation(
        root,
        observed_parents,
        confirmed_parents,
        observed,
    );
    Ok(VerifiedProcessTree::from_observed(root, observed))
}

#[cfg(target_os = "windows")]
fn windows_enumerate_process_parents() -> Result<Vec<(u32, u32)>, ProcessMemoryError> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    // SAFETY: 参数要求枚举系统进程；返回值由 OwnedWindowsHandle 负责关闭。
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_windows_error_for(
            None,
            ProcessMemoryOperation::Enumerate,
        ));
    }
    let snapshot = OwnedWindowsHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: snapshot 是有效 ToolHelp 句柄，entry 大小已正确初始化。
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return Err(last_windows_error_for(
            None,
            ProcessMemoryOperation::Enumerate,
        ));
    }

    let mut parents = Vec::new();
    loop {
        parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: 同上；返回 0 表示枚举结束。
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }
    Ok(parents)
}

#[cfg(target_os = "windows")]
fn windows_snapshot_verified_process(
    expected: ProcessIdentity,
) -> Result<VerifiedProcessMemory, ProcessMemoryError> {
    use std::mem::size_of;
    use windows_sys::Win32::System::{
        ProcessStatus::{
            K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
        },
        Threading::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    };

    let handle = windows_open_process(
        expected.pid,
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
        ProcessMemoryOperation::Open,
    )?;
    windows_verify_open_handle_identity(&handle, expected)?;
    let mut counters = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    // SAFETY: handle 在调用期间保持有效，输出缓冲区与 cb 对应实际结构大小。
    let success = unsafe {
        K32GetProcessMemoryInfo(
            handle.0,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    };
    if success == 0 {
        return Err(last_windows_error_for(
            Some(expected.pid),
            ProcessMemoryOperation::Snapshot,
        ));
    }
    Ok(VerifiedProcessMemory {
        identity: expected,
        working_set_bytes: counters.WorkingSetSize as u64,
        peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
        private_bytes: Some(counters.PrivateUsage as u64),
    })
}

#[cfg(target_os = "windows")]
fn windows_trim_verified_process(expected: ProcessIdentity) -> ProcessTrimResult {
    use windows_sys::Win32::{
        Foundation::ERROR_INVALID_PARAMETER,
        System::{
            ProcessStatus::K32EmptyWorkingSet,
            Threading::{PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA},
        },
    };

    let handle = match windows_open_process(
        expected.pid,
        PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA,
        ProcessMemoryOperation::Open,
    ) {
        Ok(handle) => handle,
        Err(error) if error.os_code == Some(ERROR_INVALID_PARAMETER as i32) => {
            return ProcessTrimResult::Skipped {
                pid: expected.pid,
                reason: ProcessTrimSkipReason::Exited,
            };
        }
        Err(error) => {
            return ProcessTrimResult::Failed {
                pid: expected.pid,
                error,
            };
        }
    };

    let actual_creation_time_100ns = match windows_creation_time_for_handle(&handle, expected.pid) {
        Ok(value) => value,
        Err(error) => {
            return ProcessTrimResult::Failed {
                pid: expected.pid,
                error,
            };
        }
    };
    if !expected.has_creation_time(actual_creation_time_100ns) {
        return ProcessTrimResult::Skipped {
            pid: expected.pid,
            reason: ProcessTrimSkipReason::IdentityChanged {
                expected_creation_time_100ns: expected.creation_time_100ns,
                actual_creation_time_100ns,
            },
        };
    }

    // SAFETY: 创建时间已在同一个 handle 上重新验证；PID 之后即使复用也不会改变该句柄目标。
    if unsafe { K32EmptyWorkingSet(handle.0) } == 0 {
        ProcessTrimResult::Failed {
            pid: expected.pid,
            error: last_windows_error_for(Some(expected.pid), ProcessMemoryOperation::Trim),
        }
    } else {
        ProcessTrimResult::Trimmed { pid: expected.pid }
    }
}

#[cfg(target_os = "windows")]
fn windows_query_creation_time(pid: u32) -> Result<u64, ProcessMemoryError> {
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = windows_open_process(
        pid,
        PROCESS_QUERY_LIMITED_INFORMATION,
        ProcessMemoryOperation::Open,
    )?;
    windows_creation_time_for_handle(&handle, pid)
}

#[cfg(target_os = "windows")]
fn windows_open_process(
    pid: u32,
    access: windows_sys::Win32::System::Threading::PROCESS_ACCESS_RIGHTS,
    operation: ProcessMemoryOperation,
) -> Result<OwnedWindowsHandle, ProcessMemoryError> {
    use windows_sys::Win32::System::Threading::OpenProcess;
    // SAFETY: PID 与 access 来自受控枚举；不继承句柄，返回句柄由 RAII 关闭。
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        Err(last_windows_error_for(Some(pid), operation))
    } else {
        Ok(OwnedWindowsHandle(handle))
    }
}

#[cfg(target_os = "windows")]
fn windows_verify_open_handle_identity(
    handle: &OwnedWindowsHandle,
    expected: ProcessIdentity,
) -> Result<(), ProcessMemoryError> {
    let actual = windows_creation_time_for_handle(handle, expected.pid)?;
    if expected.has_creation_time(actual) {
        Ok(())
    } else {
        Err(ProcessMemoryError {
            pid: Some(expected.pid),
            operation: ProcessMemoryOperation::VerifyIdentity,
            message: format!(
                "进程创建时间不匹配（expected={}, actual={}），拒绝操作复用 PID",
                expected.creation_time_100ns, actual
            ),
            os_code: None,
        })
    }
}

#[cfg(target_os = "windows")]
fn windows_creation_time_for_handle(
    handle: &OwnedWindowsHandle,
    pid: u32,
) -> Result<u64, ProcessMemoryError> {
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: handle 有效，四个 FILETIME 输出缓冲区在调用期间均有效。
    if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(last_windows_error_for(
            Some(pid),
            ProcessMemoryOperation::VerifyIdentity,
        ));
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

#[cfg(target_os = "windows")]
fn last_windows_error_for(
    pid: Option<u32>,
    operation: ProcessMemoryOperation,
) -> ProcessMemoryError {
    let error = std::io::Error::last_os_error();
    ProcessMemoryError {
        pid,
        operation,
        message: error.to_string(),
        os_code: error.raw_os_error(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        thread,
    };

    #[derive(Default)]
    struct CountingAdapter {
        calls: AtomicUsize,
    }

    impl ProcessMemoryAdapter for CountingAdapter {
        fn capability(&self) -> ProcessMemoryCapability {
            self.calls.fetch_add(1, Ordering::SeqCst);
            ProcessMemoryCapability::Available
        }

        fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(single_process_memory_snapshot(7, 128, 160, Some(96)))
        }

        fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn foreground_request_is_rejected_without_touching_platform_adapter() {
        let adapter = CountingAdapter::default();
        let governor = ResourceGovernor::default();

        let outcome = governor.trim_working_set(WindowActivity::Foreground, 20_000, &adapter);

        assert_eq!(
            outcome,
            TrimOutcome::Skipped {
                reason: TrimSkipReason::Foreground,
            }
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn explicit_manual_force_can_trim_while_the_window_is_foreground() {
        let adapter = CountingAdapter::default();
        let governor = ResourceGovernor::default();

        let outcome =
            governor.trim_working_set_manual(WindowActivity::Foreground, 20_000, true, &adapter);

        assert!(matches!(outcome, TrimOutcome::Completed { .. }));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn hidden_window_must_wait_four_seconds_before_trim() {
        let adapter = CountingAdapter::default();
        let governor = ResourceGovernor::default();

        let early = governor.trim_working_set(
            WindowActivity::Hidden { since_ms: 10_000 },
            13_999,
            &adapter,
        );
        assert_eq!(
            early,
            TrimOutcome::Skipped {
                reason: TrimSkipReason::BackgroundDelay { remaining_ms: 1 },
            }
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);

        let completed = governor.trim_working_set(
            WindowActivity::Hidden { since_ms: 10_000 },
            14_000,
            &adapter,
        );
        assert_eq!(
            completed,
            TrimOutcome::Completed {
                before: single_process_memory_snapshot(7, 128, 160, Some(96)),
                after: single_process_memory_snapshot(7, 128, 160, Some(96)),
                reclaimed_working_set_bytes: 0,
                processes: vec![ProcessTrimResult::Trimmed { pid: 7 }],
            }
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn completed_attempt_starts_a_two_minute_cooldown() {
        let adapter = CountingAdapter::default();
        let governor = ResourceGovernor::default();
        let activity = WindowActivity::Minimized { since_ms: 0 };

        assert!(matches!(
            governor.trim_working_set(activity, 4_000, &adapter),
            TrimOutcome::Completed { .. }
        ));
        assert_eq!(
            governor.trim_working_set(activity, 123_999, &adapter),
            TrimOutcome::Skipped {
                reason: TrimSkipReason::Cooldown { remaining_ms: 1 },
            }
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 4);
        assert!(matches!(
            governor.trim_working_set(activity, 124_000, &adapter),
            TrimOutcome::Completed { .. }
        ));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 8);
    }

    struct BlockingAdapter {
        trim_started: Arc<Barrier>,
        trim_release: Arc<Barrier>,
    }

    impl ProcessMemoryAdapter for BlockingAdapter {
        fn capability(&self) -> ProcessMemoryCapability {
            ProcessMemoryCapability::Available
        }

        fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
            Ok(single_process_memory_snapshot(9, 512, 640, None))
        }

        fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
            self.trim_started.wait();
            self.trim_release.wait();
            Ok(())
        }
    }

    #[test]
    fn only_one_trim_can_be_in_flight() {
        let governor = Arc::new(ResourceGovernor::default());
        let trim_started = Arc::new(Barrier::new(2));
        let trim_release = Arc::new(Barrier::new(2));
        let adapter = Arc::new(BlockingAdapter {
            trim_started: Arc::clone(&trim_started),
            trim_release: Arc::clone(&trim_release),
        });
        let worker_governor = Arc::clone(&governor);
        let worker_adapter = Arc::clone(&adapter);
        let worker = thread::spawn(move || {
            worker_governor.trim_working_set(
                WindowActivity::Hidden { since_ms: 0 },
                4_000,
                worker_adapter.as_ref(),
            )
        });

        trim_started.wait();
        let competing = governor.trim_working_set(
            WindowActivity::Hidden { since_ms: 0 },
            4_000,
            adapter.as_ref(),
        );
        assert_eq!(
            competing,
            TrimOutcome::Skipped {
                reason: TrimSkipReason::InFlight,
            }
        );

        trim_release.wait();
        assert!(matches!(
            worker.join().expect("资源线程不应 panic"),
            TrimOutcome::Completed { .. }
        ));
    }

    #[test]
    fn unsupported_adapter_does_not_create_a_fake_success_or_cooldown() {
        let governor = ResourceGovernor::default();
        let adapter = UnsupportedProcessMemoryAdapter;
        let activity = WindowActivity::Hidden { since_ms: 0 };

        let first = governor.trim_working_set(activity, 4_000, &adapter);
        let second = governor.trim_working_set(activity, 4_000, &adapter);

        assert!(matches!(
            first,
            TrimOutcome::Skipped {
                reason: TrimSkipReason::Unsupported { .. }
            }
        ));
        assert!(matches!(
            second,
            TrimOutcome::Skipped {
                reason: TrimSkipReason::Unsupported { .. }
            }
        ));
        assert_eq!(governor.snapshot().last_attempt_ms, None);
    }

    #[test]
    fn system_purge_is_explicitly_disabled_by_default() {
        let governor = ResourceGovernor::default();

        assert!(matches!(
            governor.request_system_purge(),
            SystemPurgeOutcome::Skipped {
                policy: SystemPurgePolicy::Disabled,
                ..
            }
        ));
    }

    #[test]
    fn verified_process_tree_contains_only_the_root_and_parent_chain_descendants() {
        let root = ProcessIdentity {
            pid: 10,
            parent_pid: 1,
            creation_time_100ns: 1_000,
        };
        let tree = VerifiedProcessTree::from_observed(
            root,
            vec![
                root,
                ProcessIdentity {
                    pid: 11,
                    parent_pid: 10,
                    creation_time_100ns: 1_100,
                },
                ProcessIdentity {
                    pid: 12,
                    parent_pid: 11,
                    creation_time_100ns: 1_200,
                },
                ProcessIdentity {
                    pid: 99,
                    parent_pid: 1,
                    creation_time_100ns: 900,
                },
            ],
        );

        assert_eq!(
            tree.identities()
                .iter()
                .map(|item| item.pid)
                .collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
    }

    #[test]
    fn verified_process_tree_rejects_a_child_older_than_its_reused_parent_pid() {
        let root = ProcessIdentity {
            pid: 10,
            parent_pid: 1,
            creation_time_100ns: 1_000,
        };
        let tree = VerifiedProcessTree::from_observed(
            root,
            vec![
                root,
                ProcessIdentity {
                    pid: 11,
                    parent_pid: 10,
                    creation_time_100ns: 1_300,
                },
                ProcessIdentity {
                    pid: 12,
                    parent_pid: 11,
                    creation_time_100ns: 1_200,
                },
            ],
        );

        assert_eq!(
            tree.identities()
                .iter()
                .map(|item| item.pid)
                .collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn process_discovery_rejects_a_pid_reused_between_parent_enumeration_and_creation_time_read() {
        let root = ProcessIdentity {
            pid: 10,
            parent_pid: 1,
            creation_time_100ns: 1_000,
        };
        let identities = reconcile_process_identities_after_parent_confirmation(
            root,
            vec![
                (10, 1),
                // 第一次 ToolHelp 枚举时，PID 11 仍是应用子进程。
                (11, 10),
            ],
            vec![
                // 读取创建时间期间 PID 11 已复用为无关进程。
                (11, 77),
                (10, 1),
            ],
            vec![ProcessIdentity {
                pid: 11,
                parent_pid: 10,
                creation_time_100ns: 1_200,
            }],
        );

        let tree = VerifiedProcessTree::from_observed(root, identities);

        assert_eq!(tree.identities(), &[root]);
    }

    #[test]
    fn verified_process_tree_keeps_the_root_first_when_a_child_has_a_lower_pid() {
        let root = ProcessIdentity {
            pid: 100,
            parent_pid: 1,
            creation_time_100ns: 1_000,
        };
        let tree = VerifiedProcessTree::from_observed(
            root,
            vec![ProcessIdentity {
                pid: 7,
                parent_pid: 100,
                creation_time_100ns: 1_100,
            }],
        );

        assert_eq!(tree.identities()[0], root);
        assert_eq!(tree.identities()[1].pid, 7);
    }

    #[test]
    fn process_tree_snapshot_aggregates_current_and_peak_working_set() {
        let snapshot = ProcessMemorySnapshot::from_verified_processes(
            10,
            vec![
                VerifiedProcessMemory {
                    identity: ProcessIdentity {
                        pid: 10,
                        parent_pid: 1,
                        creation_time_100ns: 1_000,
                    },
                    working_set_bytes: 100,
                    peak_working_set_bytes: 140,
                    private_bytes: Some(80),
                },
                VerifiedProcessMemory {
                    identity: ProcessIdentity {
                        pid: 11,
                        parent_pid: 10,
                        creation_time_100ns: 1_100,
                    },
                    working_set_bytes: 200,
                    peak_working_set_bytes: 360,
                    private_bytes: Some(170),
                },
            ],
            Vec::new(),
        );

        assert_eq!(snapshot.pid, 10);
        assert_eq!(snapshot.working_set_bytes, 300);
        assert_eq!(snapshot.peak_working_set_bytes, 500);
        assert_eq!(snapshot.private_bytes, Some(250));
        assert_eq!(snapshot.processes.len(), 2);
    }

    #[test]
    fn creation_identity_requires_an_exact_match_before_a_pid_can_be_operated() {
        let identity = ProcessIdentity {
            pid: 77,
            parent_pid: 10,
            creation_time_100ns: 5_000,
        };

        assert!(identity.has_creation_time(5_000));
        assert!(!identity.has_creation_time(5_001));
    }

    struct PartialTreeAdapter;

    impl ProcessMemoryAdapter for PartialTreeAdapter {
        fn capability(&self) -> ProcessMemoryCapability {
            ProcessMemoryCapability::Available
        }

        fn snapshot_current_process(&self) -> Result<ProcessMemorySnapshot, ProcessMemoryError> {
            Ok(ProcessMemorySnapshot::from_verified_processes(
                10,
                vec![
                    VerifiedProcessMemory {
                        identity: ProcessIdentity {
                            pid: 10,
                            parent_pid: 1,
                            creation_time_100ns: 1_000,
                        },
                        working_set_bytes: 100,
                        peak_working_set_bytes: 120,
                        private_bytes: Some(80),
                    },
                    VerifiedProcessMemory {
                        identity: ProcessIdentity {
                            pid: 11,
                            parent_pid: 10,
                            creation_time_100ns: 1_100,
                        },
                        working_set_bytes: 200,
                        peak_working_set_bytes: 240,
                        private_bytes: Some(160),
                    },
                ],
                Vec::new(),
            ))
        }

        fn trim_current_process(&self) -> Result<(), ProcessMemoryError> {
            unreachable!("tree adapter must use the verified tree path")
        }

        fn trim_verified_process_tree(
            &self,
            _identities: &[ProcessIdentity],
        ) -> Vec<ProcessTrimResult> {
            vec![
                ProcessTrimResult::Trimmed { pid: 10 },
                ProcessTrimResult::Skipped {
                    pid: 11,
                    reason: ProcessTrimSkipReason::IdentityChanged {
                        expected_creation_time_100ns: 1_100,
                        actual_creation_time_100ns: 2_000,
                    },
                },
            ]
        }
    }

    #[test]
    fn one_pid_identity_change_does_not_abort_the_verified_tree_trim_report() {
        let governor = ResourceGovernor::default();

        let outcome = governor.trim_working_set_manual(
            WindowActivity::Foreground,
            10_000,
            true,
            &PartialTreeAdapter,
        );

        let TrimOutcome::Completed { processes, .. } = outcome else {
            panic!("manual force should complete with a per-process report");
        };
        assert_eq!(
            processes,
            vec![
                ProcessTrimResult::Trimmed { pid: 10 },
                ProcessTrimResult::Skipped {
                    pid: 11,
                    reason: ProcessTrimSkipReason::IdentityChanged {
                        expected_creation_time_100ns: 1_100,
                        actual_creation_time_100ns: 2_000,
                    },
                },
            ]
        );
    }
}
