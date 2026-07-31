use serde::{Deserialize, Serialize};

/// 用户关闭主窗口时采用的行为。
///
/// 默认保持 Electron/Tauri 当前的退出语义；只有用户显式选择托盘后才隐藏窗口。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Exit,
    Tray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    Exit,
    HideToTray,
    Ignore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecyclePhase {
    Running,
    HiddenToTray,
    Exiting,
    Cleaned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSnapshot {
    pub close_behavior: CloseBehavior,
    pub phase: LifecyclePhase,
    pub cleanup_claimed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateExitStatus {
    Prepared,
    Sealed,
    RecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpdateExitOwnership {
    operation_id: String,
    operation_generation: u64,
    receipt: String,
    status: UpdateExitStatus,
}

impl UpdateExitOwnership {
    fn matches(&self, operation_id: &str, operation_generation: u64, receipt: &str) -> bool {
        self.operation_id == operation_id
            && self.operation_generation == operation_generation
            && self.receipt == receipt
    }
}

/// 收拢窗口关闭、托盘隐藏和真正退出的状态机。
///
/// 调用方只需要提交用户意图；资源清理的 exactly-once 不变量由本 Module 维护。
#[derive(Debug)]
pub struct ShutdownCoordinator {
    close_behavior: CloseBehavior,
    phase: LifecyclePhase,
    phase_before_exit: Option<LifecyclePhase>,
    cleanup_claimed: bool,
    update_exit: Option<UpdateExitOwnership>,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new(CloseBehavior::Exit)
    }
}

impl ShutdownCoordinator {
    pub fn new(close_behavior: CloseBehavior) -> Self {
        Self {
            close_behavior,
            phase: LifecyclePhase::Running,
            phase_before_exit: None,
            cleanup_claimed: false,
            update_exit: None,
        }
    }

    pub fn snapshot(&self) -> LifecycleSnapshot {
        LifecycleSnapshot {
            close_behavior: self.close_behavior,
            phase: self.phase,
            cleanup_claimed: self.cleanup_claimed,
        }
    }

    pub fn set_close_behavior(&mut self, behavior: CloseBehavior) -> bool {
        if matches!(
            self.phase,
            LifecyclePhase::Exiting | LifecyclePhase::Cleaned
        ) {
            return false;
        }
        self.close_behavior = behavior;
        true
    }

    pub fn request_close(&mut self, tray_available: bool) -> CloseDecision {
        if matches!(
            self.phase,
            LifecyclePhase::Exiting | LifecyclePhase::Cleaned
        ) {
            return CloseDecision::Ignore;
        }
        if self.close_behavior == CloseBehavior::Tray && tray_available {
            self.phase = LifecyclePhase::HiddenToTray;
            return CloseDecision::HideToTray;
        }
        self.phase_before_exit = Some(self.phase);
        self.phase = LifecyclePhase::Exiting;
        CloseDecision::Exit
    }

    pub fn request_show(&mut self) -> bool {
        if self.phase != LifecyclePhase::HiddenToTray {
            return false;
        }
        self.phase = LifecyclePhase::Running;
        true
    }

    pub fn request_exit(&mut self) -> bool {
        if matches!(
            self.phase,
            LifecyclePhase::Exiting | LifecyclePhase::Cleaned
        ) {
            return false;
        }
        self.phase_before_exit = Some(self.phase);
        self.phase = LifecyclePhase::Exiting;
        true
    }

    /// 可取消退出在资源清理失败后撤销 intent，使用户能够再次尝试。
    pub fn cancel_exit(&mut self) -> bool {
        if self.phase != LifecyclePhase::Exiting
            || self.cleanup_claimed
            || self.update_exit.is_some()
        {
            return false;
        }
        self.phase = self
            .phase_before_exit
            .take()
            .unwrap_or(LifecyclePhase::Running);
        true
    }

    /// 取得一次性的清理所有权。返回 false 表示另一条退出路径已完成或正在完成清理。
    pub fn claim_cleanup(&mut self) -> bool {
        if self.phase != LifecyclePhase::Exiting
            || self.cleanup_claimed
            || self.update_exit.is_some()
        {
            return false;
        }
        self.cleanup_claimed = true;
        self.phase = LifecyclePhase::Cleaned;
        self.phase_before_exit = None;
        true
    }

    pub fn prepare_update_exit(
        &mut self,
        operation_id: &str,
        operation_generation: u64,
        receipt: &str,
    ) -> bool {
        if operation_id.is_empty()
            || operation_generation == 0
            || receipt.is_empty()
            || self.cleanup_claimed
            || self.update_exit.is_some()
            || matches!(
                self.phase,
                LifecyclePhase::Exiting | LifecyclePhase::Cleaned
            )
        {
            return false;
        }
        self.phase_before_exit = Some(self.phase);
        self.phase = LifecyclePhase::Exiting;
        self.update_exit = Some(UpdateExitOwnership {
            operation_id: operation_id.to_owned(),
            operation_generation,
            receipt: receipt.to_owned(),
            status: UpdateExitStatus::Prepared,
        });
        true
    }

    pub fn seal_update_exit(
        &mut self,
        operation_id: &str,
        operation_generation: u64,
        receipt: &str,
    ) -> bool {
        let Some(ownership) = self.update_exit.as_mut() else {
            return false;
        };
        if ownership.status != UpdateExitStatus::Prepared
            || !ownership.matches(operation_id, operation_generation, receipt)
        {
            return false;
        }
        ownership.status = UpdateExitStatus::Sealed;
        true
    }

    pub fn release_update_exit(
        &mut self,
        operation_id: &str,
        operation_generation: u64,
        receipt: &str,
    ) -> bool {
        let Some(ownership) = self.update_exit.as_ref() else {
            return false;
        };
        if !ownership.matches(operation_id, operation_generation, receipt) {
            return false;
        }
        self.update_exit = None;
        self.phase = self
            .phase_before_exit
            .take()
            .unwrap_or(LifecyclePhase::Running);
        true
    }

    pub fn retain_update_exit_recovery(
        &mut self,
        operation_id: &str,
        operation_generation: u64,
        receipt: &str,
    ) -> bool {
        let Some(ownership) = self.update_exit.as_mut() else {
            return false;
        };
        if !ownership.matches(operation_id, operation_generation, receipt) {
            return false;
        }
        ownership.status = UpdateExitStatus::RecoveryRequired;
        true
    }

    pub fn update_exit_status(&self) -> Option<UpdateExitStatus> {
        self.update_exit.as_ref().map(|ownership| ownership.status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_close_requests_real_exit() {
        let mut lifecycle = ShutdownCoordinator::default();

        assert_eq!(lifecycle.request_close(false), CloseDecision::Exit);
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::Exiting);
        assert!(lifecycle.claim_cleanup());
    }

    #[test]
    fn tray_close_hides_without_claiming_cleanup() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);

        assert_eq!(lifecycle.request_close(true), CloseDecision::HideToTray);
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::HiddenToTray);
        assert!(!lifecycle.claim_cleanup());
    }

    #[test]
    fn explicit_exit_after_tray_hide_claims_cleanup_once() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);
        assert_eq!(lifecycle.request_close(true), CloseDecision::HideToTray);

        assert!(lifecycle.request_exit());
        assert!(lifecycle.claim_cleanup());
        assert!(!lifecycle.claim_cleanup());
        assert!(!lifecycle.request_exit());
    }

    #[test]
    fn tray_creation_failure_falls_back_to_exit() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);

        assert_eq!(lifecycle.request_close(false), CloseDecision::Exit);
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::Exiting);
    }

    #[test]
    fn show_restores_hidden_runtime_but_cannot_revive_exit() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);
        assert_eq!(lifecycle.request_close(true), CloseDecision::HideToTray);
        assert!(lifecycle.request_show());
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::Running);

        lifecycle.set_close_behavior(CloseBehavior::Exit);
        assert_eq!(lifecycle.request_close(true), CloseDecision::Exit);
        assert!(!lifecycle.request_show());
    }

    #[test]
    fn failed_exit_can_restore_running_phase_and_retry() {
        let mut lifecycle = ShutdownCoordinator::default();

        assert!(lifecycle.request_exit());
        assert!(lifecycle.cancel_exit());
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::Running);
        assert!(lifecycle.request_exit());
    }

    #[test]
    fn failed_tray_exit_restores_hidden_phase() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);
        assert_eq!(lifecycle.request_close(true), CloseDecision::HideToTray);

        assert!(lifecycle.request_exit());
        assert!(lifecycle.cancel_exit());

        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::HiddenToTray);
        assert!(lifecycle.request_show());
    }

    #[test]
    fn update_exit_ownership_is_exact_reversible_and_skips_normal_cleanup() {
        let mut lifecycle = ShutdownCoordinator::new(CloseBehavior::Tray);
        assert_eq!(lifecycle.request_close(true), CloseDecision::HideToTray);

        assert!(lifecycle.prepare_update_exit("a", 7, "receipt-a"));
        assert_eq!(
            lifecycle.update_exit_status(),
            Some(UpdateExitStatus::Prepared)
        );
        assert!(!lifecycle.request_exit());
        assert!(!lifecycle.cancel_exit());
        assert!(!lifecycle.claim_cleanup());
        assert!(!lifecycle.seal_update_exit("a", 8, "receipt-a"));
        assert!(lifecycle.seal_update_exit("a", 7, "receipt-a"));
        assert_eq!(
            lifecycle.update_exit_status(),
            Some(UpdateExitStatus::Sealed)
        );

        assert!(!lifecycle.release_update_exit("a", 7, "forged"));
        assert!(lifecycle.release_update_exit("a", 7, "receipt-a"));
        assert_eq!(lifecycle.update_exit_status(), None);
        assert_eq!(lifecycle.snapshot().phase, LifecyclePhase::HiddenToTray);
    }
}
