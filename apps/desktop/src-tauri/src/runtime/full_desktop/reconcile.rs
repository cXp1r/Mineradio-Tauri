//! Explorer watcher 的纯调度策略。
//!
//! 本模块不触碰 Tauri、线程或平台 adapter；它只决定何时允许排队一次 reconcile。

pub const ACTIVE_RECONCILE_MIN_INTERVAL_MS: u64 = 1_000;
pub const INACTIVE_OBSERVE_INTERVAL_MS: u64 = 30_000;
const MAX_BACKOFF_INTERVAL_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconcileOutcome {
    Success,
    Failure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconcileDecision {
    Queue { generation: u64 },
    WaitUntil(u64),
    InFlight,
    Stopped,
}

impl ReconcileDecision {
    pub fn queued_generation(self) -> Option<u64> {
        match self {
            Self::Queue { generation } => Some(generation),
            Self::WaitUntil(_) | Self::InFlight | Self::Stopped => None,
        }
    }
}

/// Watcher 的单一事实来源。generation 令已停止 worker 或过期 main-thread callback
/// 无法提交结果；in-flight 保证同一时刻最多一个 platform reconcile。
#[derive(Debug)]
pub struct ExplorerReconcilePolicy {
    generation: u64,
    in_flight: Option<u64>,
    next_due_ms: u64,
    failed_attempts: u32,
    stopped: bool,
    last_active: Option<bool>,
}

impl ExplorerReconcilePolicy {
    pub fn new(now_ms: u64) -> Self {
        Self {
            generation: 0,
            in_flight: None,
            next_due_ms: now_ms,
            failed_attempts: 0,
            stopped: false,
            last_active: None,
        }
    }

    /// 只在 active phase 返回 `Queue`。inactive 返回低频 wakeup，调用方不得把它解释为
    /// 平台 reconcile；这使 disabled/recovering 状态不会碰 Explorer。
    pub fn poll(&mut self, now_ms: u64, active: bool) -> ReconcileDecision {
        if self.stopped {
            return ReconcileDecision::Stopped;
        }
        if self.last_active != Some(active) {
            self.last_active = Some(active);
            self.next_due_ms = if active {
                now_ms
            } else {
                now_ms.saturating_add(INACTIVE_OBSERVE_INTERVAL_MS)
            };
        }
        if !active {
            if now_ms >= self.next_due_ms {
                self.next_due_ms = now_ms.saturating_add(INACTIVE_OBSERVE_INTERVAL_MS);
            }
            return ReconcileDecision::WaitUntil(self.next_due_ms);
        }
        if self.in_flight.is_some() {
            return ReconcileDecision::InFlight;
        }
        if now_ms < self.next_due_ms {
            return ReconcileDecision::WaitUntil(self.next_due_ms);
        }
        self.generation = self.generation.wrapping_add(1);
        self.in_flight = Some(self.generation);
        ReconcileDecision::Queue {
            generation: self.generation,
        }
    }

    /// 只接受当前 in-flight generation；迟到 callback 不能覆盖新一轮退避或 shutdown。
    pub fn complete(&mut self, generation: u64, now_ms: u64, outcome: ReconcileOutcome) -> bool {
        if self.stopped || self.in_flight != Some(generation) {
            return false;
        }
        self.in_flight = None;
        let interval = match outcome {
            ReconcileOutcome::Success => {
                self.failed_attempts = 0;
                ACTIVE_RECONCILE_MIN_INTERVAL_MS
            }
            ReconcileOutcome::Failure => {
                self.failed_attempts = self.failed_attempts.saturating_add(1);
                failure_backoff_ms(self.failed_attempts)
            }
        };
        self.next_due_ms = now_ms.saturating_add(interval);
        true
    }

    /// 退出先取消 watcher，随后 caller 才能 rollback。递增 generation 使已排队 callback 失效。
    pub fn shutdown(&mut self) {
        self.stopped = true;
        self.generation = self.generation.wrapping_add(1);
        self.in_flight = None;
    }
}

fn failure_backoff_ms(failed_attempts: u32) -> u64 {
    let multiplier = 1u64.checked_shl(failed_attempts.min(5)).unwrap_or(u64::MAX);
    ACTIVE_RECONCILE_MIN_INTERVAL_MS
        .saturating_mul(multiplier)
        .min(MAX_BACKOFF_INTERVAL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_reconcile_never_polls_faster_than_one_second() {
        let mut policy = ExplorerReconcilePolicy::new(0);
        let first = policy.poll(0, true);
        let generation = first.queued_generation().expect("first reconcile queues");
        policy.complete(generation, 0, ReconcileOutcome::Success);

        assert_eq!(policy.poll(999, true), ReconcileDecision::WaitUntil(1_000));
        assert!(matches!(
            policy.poll(1_000, true),
            ReconcileDecision::Queue { .. }
        ));
    }

    #[test]
    fn only_one_reconcile_can_be_in_flight() {
        let mut policy = ExplorerReconcilePolicy::new(0);
        let first = policy.poll(0, true);
        assert!(matches!(first, ReconcileDecision::Queue { .. }));
        assert_eq!(policy.poll(5_000, true), ReconcileDecision::InFlight);
    }

    #[test]
    fn inactive_mode_observes_at_low_frequency_without_queueing_mutation() {
        let mut policy = ExplorerReconcilePolicy::new(0);
        assert_eq!(
            policy.poll(0, false),
            ReconcileDecision::WaitUntil(INACTIVE_OBSERVE_INTERVAL_MS)
        );
        assert_eq!(
            policy.poll(INACTIVE_OBSERVE_INTERVAL_MS, false),
            ReconcileDecision::WaitUntil(INACTIVE_OBSERVE_INTERVAL_MS * 2)
        );
    }

    #[test]
    fn failed_generation_uses_bounded_exponential_backoff() {
        let mut policy = ExplorerReconcilePolicy::new(0);
        let first = policy.poll(0, true).queued_generation().expect("queue");
        policy.complete(first, 0, ReconcileOutcome::Failure);
        assert_eq!(
            policy.poll(1_000, true),
            ReconcileDecision::WaitUntil(2_000)
        );
        let second = policy.poll(2_000, true).queued_generation().expect("queue");
        policy.complete(second, 2_000, ReconcileOutcome::Failure);
        assert_eq!(
            policy.poll(5_999, true),
            ReconcileDecision::WaitUntil(6_000)
        );
    }

    #[test]
    fn shutdown_cancels_old_generation_and_prevents_new_work() {
        let mut policy = ExplorerReconcilePolicy::new(0);
        let generation = policy.poll(0, true).queued_generation().expect("queue");
        policy.shutdown();
        policy.complete(generation, 1_000, ReconcileOutcome::Success);
        assert_eq!(policy.poll(10_000, true), ReconcileDecision::Stopped);
    }
}
