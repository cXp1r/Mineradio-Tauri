//! exact Wallpaper Engine location 的周期静音重申 owner。
//!
//! 首次静音由 caller 同步确认；owner 只对同一份已验证的 prepared/ownership 周期重申，
//! 不触碰全局 mute，也不管理 Wallpaper Engine 核心进程。

use super::{
    error::{WindowsWallpaperError, WindowsWallpaperResult},
    scene::{PreparedWindowsScene, SceneController, WindowsSceneOwnership},
};
use std::{
    sync::{mpsc, Arc, Mutex, MutexGuard},
    thread::{self, JoinHandle},
    time::Duration,
};

const REASSERT_INTERVAL: Duration = Duration::from_secs(12);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocationMuteStatus {
    pub ready: bool,
    pub stopped: bool,
    pub last_error_code: Option<&'static str>,
}

impl Default for LocationMuteStatus {
    fn default() -> Self {
        Self {
            ready: true,
            stopped: false,
            last_error_code: None,
        }
    }
}

type ReassertTask = Box<dyn Fn() -> WindowsWallpaperResult<()> + Send + 'static>;

/// 单一线程 owner。显式 `stop` 会等待 worker 确认退出；Drop 只发送停止意图，避免
/// 在异常栈展开时无限阻塞。
pub struct LocationMuteOwner {
    status: Arc<Mutex<LocationMuteStatus>>,
    stop: mpsc::Sender<()>,
    stopped: mpsc::Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

impl LocationMuteOwner {
    /// caller 必须已经通过 `apply_location_mute` 确认首次静音成功。
    pub fn start_confirmed(
        prepared: PreparedWindowsScene,
        ownership: WindowsSceneOwnership,
    ) -> WindowsWallpaperResult<Self> {
        Self::start_with_task(
            Box::new(move || SceneController.reassert_location_mute_once(&prepared, &ownership)),
            REASSERT_INTERVAL,
        )
    }

    fn start_with_task(task: ReassertTask, interval: Duration) -> WindowsWallpaperResult<Self> {
        if interval.is_zero() {
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_MUTE_OWNER_INVALID",
                "静音重申 interval 必须大于零",
            ));
        }
        let status = Arc::new(Mutex::new(LocationMuteStatus::default()));
        let worker_status = Arc::clone(&status);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("mineradio-we-location-mute".to_owned())
            .spawn(move || {
                loop {
                    match stop_rx.recv_timeout(interval) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => match task() {
                            Ok(()) => {}
                            Err(error) => {
                                let mut current = lock_status(&worker_status);
                                current.ready = false;
                                current.last_error_code = Some(error.code());
                                break;
                            }
                        },
                    }
                }
                {
                    let mut current = lock_status(&worker_status);
                    current.ready = false;
                    current.stopped = true;
                }
                let _ = stopped_tx.send(());
            })
            .map_err(|error| {
                WindowsWallpaperError::new(
                    "WALLPAPER_ENGINE_MUTE_OWNER_START_FAILED",
                    format!("创建 location mute worker 失败：{error}"),
                )
            })?;
        Ok(Self {
            status,
            stop: stop_tx,
            stopped: stopped_rx,
            thread: Some(thread),
        })
    }

    pub fn status(&self) -> LocationMuteStatus {
        lock_status(&self.status).clone()
    }

    pub fn stop(&mut self) -> WindowsWallpaperResult<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let _ = self.stop.send(());
        if self.stopped.recv_timeout(STOP_TIMEOUT).is_err() {
            self.thread = Some(thread);
            return Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_MUTE_OWNER_STOP_TIMEOUT",
                "location mute worker 未在有界时间内确认退出",
            ));
        }
        thread.join().map_err(|_| {
            WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_MUTE_OWNER_THREAD_FAILED",
                "location mute worker panic",
            )
        })?;
        Ok(())
    }
}

impl Drop for LocationMuteOwner {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let _ = self.stop.send(());
            self.thread.take();
        }
    }
}

fn lock_status(status: &Arc<Mutex<LocationMuteStatus>>) -> MutexGuard<'_, LocationMuteStatus> {
    status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{LocationMuteOwner, ReassertTask};
    use crate::platform::windows::wallpaper_engine::error::WindowsWallpaperError;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    fn wait_until_stopped(owner: &LocationMuteOwner) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while !owner.status().stopped && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(owner.status().stopped, "fixture worker 应有界退休");
    }

    #[test]
    fn reassert_failure_revokes_ready_and_stop_remains_idempotent() {
        let calls = Arc::new(AtomicUsize::new(0));
        let task_calls = Arc::clone(&calls);
        let task: ReassertTask = Box::new(move || {
            task_calls.fetch_add(1, Ordering::SeqCst);
            Err(WindowsWallpaperError::new(
                "WALLPAPER_ENGINE_AUDIO_SUPPRESSION_FAILED",
                "fixture",
            ))
        });
        let mut owner = LocationMuteOwner::start_with_task(task, Duration::from_millis(1))
            .expect("owner 应启动");

        wait_until_stopped(&owner);
        let status = owner.status();
        assert!(!status.ready);
        assert_eq!(
            status.last_error_code,
            Some("WALLPAPER_ENGINE_AUDIO_SUPPRESSION_FAILED")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        owner.stop().expect("已退休 owner 应确认 join");
        owner.stop().expect("重复 stop 应幂等");
    }

    #[test]
    fn explicit_stop_confirms_release_without_an_extra_reassertion() {
        let calls = Arc::new(AtomicUsize::new(0));
        let task_calls = Arc::clone(&calls);
        let task: ReassertTask = Box::new(move || {
            task_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        let mut owner =
            LocationMuteOwner::start_with_task(task, Duration::from_secs(1)).expect("owner 应启动");

        owner.stop().expect("stop 应确认 worker 退出");
        owner.stop().expect("重复 stop 应幂等");
        assert!(owner.status().stopped);
        assert!(!owner.status().ready);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
