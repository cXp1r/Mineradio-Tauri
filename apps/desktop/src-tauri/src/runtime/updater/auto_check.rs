use std::{
    future::Future,
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio_util::sync::CancellationToken;

use super::UpdateRuntime;

pub(crate) const INITIAL_DELAY_MIN_MILLIS: u64 = 15_000;
pub(crate) const INITIAL_DELAY_MAX_MILLIS: u64 = 30_000;
pub(crate) const SUCCESS_INTERVAL_MILLIS: u64 = 24 * 60 * 60 * 1_000;

/// 更新调度唯一的时间 seam。生产与测试必须共享同一个 clock，避免限频与持久化时间漂移。
pub(crate) trait UpdateTime: Send + Sync {
    fn now_millis(&self) -> Result<u64, &'static str>;

    fn startup_delay_millis(&self) -> Result<u64, &'static str>;

    /// 返回 true 表示等待完整结束；false 表示取消。
    fn sleep<'a>(
        &'a self,
        delay_millis: u64,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

#[derive(Debug, Default)]
pub(crate) struct SystemUpdateTime;

impl UpdateTime for SystemUpdateTime {
    fn now_millis(&self) -> Result<u64, &'static str> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "UPDATE_POLICY_CLOCK_REJECTED")?;
        u64::try_from(elapsed.as_millis()).map_err(|_| "UPDATE_POLICY_CLOCK_REJECTED")
    }

    fn startup_delay_millis(&self) -> Result<u64, &'static str> {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(|_| "UPDATE_AUTO_CHECK_JITTER_REJECTED")?;
        let width = INITIAL_DELAY_MAX_MILLIS - INITIAL_DELAY_MIN_MILLIS + 1;
        Ok(INITIAL_DELAY_MIN_MILLIS + u64::from_le_bytes(random) % width)
    }

    fn sleep<'a>(
        &'a self,
        delay_millis: u64,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay_millis)) => true,
                _ = cancellation.cancelled() => false,
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutomaticCheckOutcome {
    Started,
    Completed,
    Throttled,
    Busy,
    PolicyBlocked,
    Disabled,
    Cancelled,
    RecoveryUnavailable,
    TimingUnavailable,
}

/// #54 才会接入 bootstrap；当前 module 只提供可独立验证的启动编排。
pub(crate) struct StartupUpdateScheduler;

impl StartupUpdateScheduler {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn run_once(
        &self,
        runtime: &UpdateRuntime,
        cancellation: CancellationToken,
    ) -> AutomaticCheckOutcome {
        let recovered = tokio::select! {
            _ = cancellation.cancelled() => return AutomaticCheckOutcome::Cancelled,
            recovered = runtime.run_pending_cache_recovery() => recovered,
        };
        if !recovered {
            return AutomaticCheckOutcome::RecoveryUnavailable;
        }

        let delay_millis = match runtime.time.startup_delay_millis() {
            Ok(delay_millis)
                if (INITIAL_DELAY_MIN_MILLIS..=INITIAL_DELAY_MAX_MILLIS)
                    .contains(&delay_millis) =>
            {
                delay_millis
            }
            _ => return AutomaticCheckOutcome::TimingUnavailable,
        };
        if !runtime.time.sleep(delay_millis, cancellation.clone()).await {
            return AutomaticCheckOutcome::Cancelled;
        }
        if cancellation.is_cancelled() {
            return AutomaticCheckOutcome::Cancelled;
        }

        tokio::select! {
            biased;
            _ = cancellation.cancelled() => AutomaticCheckOutcome::Cancelled,
            outcome = runtime.run_automatic_check() => outcome,
        }
    }
}
