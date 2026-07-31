use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
};

/// 在一次 updater 文件事务期间固定受管目录的完整祖先链。
///
/// Windows Adapter 会对从卷根到目标目录的每一级目录持有 no-share-delete
/// handle。最终叶子仍须通过本 module 的 no-follow interface 打开；两者结合后，
/// caller 不需要在 `symlink_metadata` 与实际 I/O 之间自行维护 TOCTOU 检查。
#[derive(Debug)]
pub(crate) struct StableDirectory {
    path: PathBuf,
    #[cfg(windows)]
    _guards: Vec<std::os::windows::io::OwnedHandle>,
}

impl StableDirectory {
    /// 打开已存在的完整目录链。目标不存在时返回 `None`；任一级是 reparse point
    /// 或非目录时 fail closed。
    pub(crate) fn open_existing(path: impl AsRef<Path>) -> io::Result<Option<Self>> {
        let path = validate_absolute_directory_path(path.as_ref())?;
        open_directory_chain(&path, false)
    }

    /// 在已固定的父目录下逐级创建缺失目录，并固定完整祖先链。
    pub(crate) fn open_or_create(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = validate_absolute_directory_path(path.as_ref())?;
        open_directory_chain(&path, true)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "managed updater directory disappeared while opening",
            )
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 只枚举名称；条目类型不可信，caller 必须随后通过本 module 的 handle
    /// interface 打开或删除该名称。
    pub(crate) fn entry_names(&self) -> io::Result<Vec<OsString>> {
        fs::read_dir(&self.path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    }

    /// 用 no-follow handle 打开普通文件。Windows 上只共享读取，因而在 handle
    /// 生命周期内拒绝并发写入、删除和重命名。
    pub(crate) fn open_regular_read(&self, name: &OsStr) -> io::Result<Option<File>> {
        let path = self.leaf_path(name)?;
        open_regular_read(&path)
    }

    /// 原子创建一个可由同一 handle 发布或清理的普通文件。
    ///
    /// Windows handle 拥有 WRITE + DELETE 且不共享任何访问；caller 可以把它
    /// 转成 Tokio file 写入，完成 flush/sync 后再交给 `publish_without_replace`。
    pub(crate) fn create_new_renameable(&self, name: &OsStr) -> io::Result<File> {
        let path = self.leaf_path(name)?;
        create_new_renameable(&path)
    }

    /// 通过已经写入并同步的同一 handle 发布文件，且绝不替换既有目标。
    pub(crate) fn publish_without_replace(
        &self,
        file: &File,
        source_name: &OsStr,
        destination_name: &OsStr,
    ) -> io::Result<()> {
        let source = self.leaf_path(source_name)?;
        let destination = self.leaf_path(destination_name)?;
        publish_without_replace(file, &source, &destination)
    }

    /// 通过已经写入并同步的同一 handle 原子替换最终叶子。
    ///
    /// 目标存在时必须先是 no-follow 普通文件；目录和 reparse point 一律拒绝。
    /// Windows 发布本身仍绑定 source handle，不重新按临时路径解析 source。
    pub(crate) fn publish_replace(
        &self,
        file: &File,
        source_name: &OsStr,
        destination_name: &OsStr,
    ) -> io::Result<()> {
        let source = self.leaf_path(source_name)?;
        let destination = self.leaf_path(destination_name)?;
        // 读取 handle 不共享 DELETE；先验证现有目标，再释放它执行原子替换。
        // SetFileInformationByHandle 不会跟随最终目标，即使有并发替换也不会
        // 把写入导向受管目录以外。
        drop(open_regular_read(&destination)?);
        publish_replace(file, &source, &destination)
    }

    /// 打开最终叶子的 no-follow DELETE handle、确认它是普通文件，再通过同一
    /// handle 删除。返回 `false` 表示叶子不存在。
    pub(crate) fn remove_regular(&self, name: &OsStr) -> io::Result<bool> {
        let path = self.leaf_path(name)?;
        remove_regular(&path)
    }

    fn leaf_path(&self, name: &OsStr) -> io::Result<PathBuf> {
        validate_leaf_name(name)?;
        Ok(self.path.join(name))
    }
}

fn validate_absolute_directory_path(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed updater directory must be absolute",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed updater directory must be lexically normalized",
        ));
    }
    Ok(path.to_path_buf())
}

fn validate_leaf_name(name: &OsStr) -> io::Result<()> {
    let path = Path::new(name);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed updater leaf name must contain exactly one normal component",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_directory_chain(path: &Path, create_missing: bool) -> io::Result<Option<StableDirectory>> {
    let ancestors = path.ancestors().collect::<Vec<_>>();
    let mut guards = Vec::with_capacity(ancestors.len());

    for ancestor in ancestors
        .into_iter()
        .rev()
        .filter(|item| !item.as_os_str().is_empty())
    {
        let handle = match open_directory_guard(ancestor) {
            Ok(handle) => handle,
            Err(error) if windows_error_is_not_found(&error) && create_missing => {
                match fs::create_dir(ancestor) {
                    Ok(()) => {}
                    Err(create_error) if create_error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(create_error) => return Err(create_error),
                }
                open_directory_guard(ancestor)?
            }
            Err(error) if windows_error_is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        guards.push(handle);
    }

    Ok(Some(StableDirectory {
        path: path.to_path_buf(),
        _guards: guards,
    }))
}

#[cfg(not(windows))]
fn open_directory_chain(path: &Path, create_missing: bool) -> io::Result<Option<StableDirectory>> {
    // 正式 updater 只支持 Windows NSIS。非 Windows Adapter 保留 fail-closed 的
    // link 检查，便于跨平台编译和纯逻辑测试，但不宣称提供 Windows share-mode
    // 等价保证。
    let ancestors = path.ancestors().collect::<Vec<_>>();
    for ancestor in ancestors
        .into_iter()
        .rev()
        .filter(|item| !item.as_os_str().is_empty())
    {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "managed updater directory chain contains an unsafe entry",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && create_missing => {
                match fs::create_dir(ancestor) {
                    Ok(()) => {}
                    Err(create_error) if create_error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(create_error) => return Err(create_error),
                }
                let metadata = fs::symlink_metadata(ancestor)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "managed updater directory chain contains an unsafe entry",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(StableDirectory {
        path: path.to_path_buf(),
    }))
}

#[cfg(windows)]
fn open_directory_guard(path: &Path) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::FromRawHandle as _;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let wide = windows_wide_path(path)?;
    // 不共享 DELETE：当前 handle 存活期间，该目录不能被删除或重命名。
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw.cast()) };
    let attributes = windows_handle_attributes(&handle)?;
    if attributes_are_reparse(attributes) || !attributes_are_directory(attributes) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed updater directory is not a regular no-follow directory",
        ));
    }
    Ok(handle)
}

#[cfg(windows)]
fn open_regular_read(path: &Path) -> io::Result<Option<File>> {
    use std::os::windows::{fs::MetadataExt as _, fs::OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ,
    };

    let file = match OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if windows_error_is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let attributes = file.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed updater leaf is not a regular no-follow file",
        ));
    }
    Ok(Some(file))
}

#[cfg(not(windows))]
fn open_regular_read(path: &Path) -> io::Result<Option<File>> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;

    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed updater leaf is not a regular file",
        ));
    }
    let file = OpenOptions::new().read(true).open(path)?;
    let handle_metadata = file.metadata()?;
    if !handle_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed updater leaf changed while opening",
        ));
    }
    #[cfg(unix)]
    if path_metadata.dev() != handle_metadata.dev() || path_metadata.ino() != handle_metadata.ino()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "managed updater leaf changed while opening",
        ));
    }
    Ok(Some(file))
}

#[cfg(windows)]
fn create_new_renameable(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH, FILE_GENERIC_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_WRITE | DELETE)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH);
    let file = options.open(path)?;
    let attributes = file.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "created updater leaf is not a regular no-follow file",
        ));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn create_new_renameable(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(windows)]
fn publish_without_replace(file: &File, _source: &Path, destination: &Path) -> io::Result<()> {
    publish_by_handle(file, destination, false)
}

#[cfg(windows)]
fn publish_replace(file: &File, _source: &Path, destination: &Path) -> io::Result<()> {
    publish_by_handle(file, destination, true)
}

#[cfg(windows)]
fn publish_by_handle(file: &File, destination: &Path, replace: bool) -> io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt as _, os::windows::io::AsRawHandle as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, FileRenameInfoEx, FlushFileBuffers, SetFileInformationByHandle,
        FILE_RENAME_INFO,
    };

    // FileRenameInfoEx 没有 WRITE_THROUGH flag；Windows SDK 只为 path-based
    // MoveFileExW 暴露该语义。这里不能退回 path API，否则会重新解析临时文件名并
    // 恢复 TOCTOU。我们改为：创建时 FILE_FLAG_WRITE_THROUGH、rename 前后对同一
    // source handle FlushFileBuffers。NTFS rename 仍由单次 metadata journal
    // transaction 提交，而 source identity 始终由当前 handle 固定。
    flush_windows_file(file, FlushFileBuffers)?;

    let mut destination = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    let name_bytes = destination
        .len()
        .checked_mul(mem::size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "updater path too long"))?;
    // FileNameLength 不含终止符；仍给 Win32 buffer 追加 NUL，避免旧版
    // FileRenameInfo 实现越过声明长度读取未初始化的 UTF-16 尾部。
    destination.push(0);
    let allocated_name_bytes = destination
        .len()
        .checked_mul(mem::size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "updater path too long"))?;
    let buffer_bytes = mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(allocated_name_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "updater path too long"))?;
    let mut buffer = vec![0usize; buffer_bytes.div_ceil(mem::size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        // FILE_RENAME_FLAG_REPLACE_IF_EXISTS = 0x1。windows-sys 将该常量放在
        // 未启用的 WindowsProgramming feature；此值来自 Win32 ABI。
        (*info).Anonymous.Flags = u32::from(replace);
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = u32::try_from(name_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "updater path too long"))?;
        std::ptr::copy_nonoverlapping(
            destination.as_ptr(),
            buffer
                .as_mut_ptr()
                .cast::<u8>()
                .add(mem::offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>(),
            destination.len(),
        );
    }
    let extended_result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            buffer.as_ptr().cast(),
            u32::try_from(buffer_bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "updater path too long")
            })?,
        )
    };
    if extended_result == 0 {
        let extended_error = io::Error::last_os_error();
        // 老系统可能不识别 FileRenameInfoEx。兼容路径仍使用同一个 source
        // handle 和 legacy FileRenameInfo，绝不退回 MoveFileExW 的路径重解析。
        if !matches!(extended_error.raw_os_error(), Some(1 | 50 | 87)) {
            return Err(extended_error);
        }
        unsafe {
            (*info).Anonymous.ReplaceIfExists = replace;
        }
        let legacy_result = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileRenameInfo,
                buffer.as_ptr().cast(),
                u32::try_from(buffer_bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "updater path too long")
                })?,
            )
        };
        if legacy_result == 0 {
            return Err(io::Error::last_os_error());
        }
    }

    flush_windows_file(file, FlushFileBuffers)
}

#[cfg(windows)]
fn flush_windows_file(
    file: &File,
    flush: unsafe extern "system" fn(windows_sys::Win32::Foundation::HANDLE) -> i32,
) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;

    if unsafe { flush(file.as_raw_handle()) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish_without_replace(_file: &File, source: &Path, destination: &Path) -> io::Result<()> {
    // hard_link 的目标创建是 no-replace；若随后清理 source 失败，会留下可被
    // 启动恢复识别的不完整 pair，而不会静默覆盖既有 verified cache。
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

#[cfg(not(windows))]
fn publish_replace(_file: &File, source: &Path, destination: &Path) -> io::Result<()> {
    // 非 Windows 仅用于跨平台逻辑测试；生产 NSIS Adapter 走同 handle 的 Win32
    // 路径。先前的 no-follow 验证保证这里不会主动覆盖链接或目录。
    fs::rename(source, destination)
}

#[cfg(windows)]
fn remove_regular(path: &Path) -> io::Result<bool> {
    use std::{mem, os::windows::io::AsRawHandle as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, FileDispositionInfoEx, SetFileInformationByHandle,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
    };

    let Some(file) = open_regular_for_delete(path)? else {
        return Ok(false);
    };
    let extended = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let extended_result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            (&raw const extended).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if extended_result != 0 {
        return Ok(true);
    }

    let legacy = FILE_DISPOSITION_INFO { DeleteFile: true };
    let legacy_result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const legacy).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if legacy_result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(true)
    }
}

#[cfg(windows)]
fn open_regular_for_delete(path: &Path) -> io::Result<Option<File>> {
    use std::os::windows::{fs::MetadataExt as _, fs::OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .access_mode(DELETE | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if windows_error_is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let attributes = file.metadata()?.file_attributes();
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to delete a non-regular updater leaf",
        ));
    }
    Ok(Some(file))
}

#[cfg(not(windows))]
fn remove_regular(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to delete a non-regular updater leaf",
        ));
    }
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(windows)]
fn windows_handle_attributes(handle: &std::os::windows::io::OwnedHandle) -> io::Result<u32> {
    use std::{mem::size_of, os::windows::io::AsRawHandle as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO,
    };

    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle().cast(),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(info.FileAttributes)
    }
}

#[cfg(windows)]
fn attributes_are_reparse(attributes: u32) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn attributes_are_directory(attributes: u32) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
    attributes & FILE_ATTRIBUTE_DIRECTORY != 0
}

#[cfg(windows)]
fn windows_error_is_not_found(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(2 | 3))
}

#[cfg(windows)]
fn windows_wide_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt as _;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows updater path contains a NUL character",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            for _ in 0..8 {
                let mut nonce = [0_u8; 16];
                getrandom::fill(&mut nonce).expect("应生成 managed-fs 测试目录随机数");
                let suffix = nonce
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let path = std::env::temp_dir()
                    .join(format!("mineradio-updater-managed-fs-{label}-{suffix}"));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("应创建 managed-fs 测试目录：{error}"),
                }
            }
            panic!("无法分配唯一的 managed-fs 测试目录")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn leaf_names_cannot_escape_the_stable_directory() {
        let root = TestDirectory::new("leaf-name");
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        assert_eq!(directory.path(), root.0.as_path());

        for rejected in ["", ".", "..", "../outside", "nested/file"] {
            assert_eq!(
                directory
                    .open_regular_read(OsStr::new(rejected))
                    .expect_err("路径穿越名称必须被拒绝")
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn renameable_file_is_published_without_replacing_an_existing_destination() {
        let root = TestDirectory::new("publish");
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        let mut first = directory
            .create_new_renameable(OsStr::new("candidate.json.tmp"))
            .unwrap();
        first.write_all(b"first").unwrap();
        first.sync_all().unwrap();
        directory
            .publish_without_replace(
                &first,
                OsStr::new("candidate.json.tmp"),
                OsStr::new("candidate.json"),
            )
            .unwrap();
        drop(first);
        assert_eq!(
            directory.entry_names().unwrap(),
            vec![OsString::from("candidate.json")]
        );

        let mut second = directory
            .create_new_renameable(OsStr::new("second.tmp"))
            .unwrap();
        second.write_all(b"second").unwrap();
        second.sync_all().unwrap();
        directory
            .publish_without_replace(
                &second,
                OsStr::new("second.tmp"),
                OsStr::new("candidate.json"),
            )
            .expect_err("发布不得替换既有 verified metadata");
        drop(second);

        assert_eq!(fs::read(root.0.join("candidate.json")).unwrap(), b"first");
    }

    #[test]
    fn renameable_file_atomically_replaces_an_existing_regular_destination() {
        let root = TestDirectory::new("replace");
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        fs::write(root.0.join("policy.json"), b"old").unwrap();
        let mut replacement = directory
            .create_new_renameable(OsStr::new("policy.tmp"))
            .unwrap();
        replacement.write_all(b"new").unwrap();
        replacement.sync_all().unwrap();

        directory
            .publish_replace(
                &replacement,
                OsStr::new("policy.tmp"),
                OsStr::new("policy.json"),
            )
            .unwrap();
        drop(replacement);

        assert_eq!(fs::read(root.0.join("policy.json")).unwrap(), b"new");
        assert!(!root.0.join("policy.tmp").exists());
    }

    #[test]
    fn replace_refuses_an_existing_directory_and_preserves_the_source() {
        let root = TestDirectory::new("replace-directory");
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        fs::create_dir(root.0.join("policy.json")).unwrap();
        let mut replacement = directory
            .create_new_renameable(OsStr::new("policy.tmp"))
            .unwrap();
        replacement.write_all(b"new").unwrap();
        replacement.sync_all().unwrap();

        directory
            .publish_replace(
                &replacement,
                OsStr::new("policy.tmp"),
                OsStr::new("policy.json"),
            )
            .expect_err("目录不能成为原子替换目标");
        drop(replacement);

        assert!(root.0.join("policy.json").is_dir());
        assert_eq!(fs::read(root.0.join("policy.tmp")).unwrap(), b"new");
    }

    #[test]
    fn regular_leaf_removal_is_bounded_to_the_stable_directory() {
        let root = TestDirectory::new("remove");
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        fs::write(root.0.join("installer.part"), b"partial").unwrap();

        assert!(directory
            .remove_regular(OsStr::new("installer.part"))
            .unwrap());
        assert!(!directory
            .remove_regular(OsStr::new("installer.part"))
            .unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn complete_ancestor_chain_rejects_a_directory_reparse_point() {
        use std::os::windows::fs::symlink_dir;

        let root = TestDirectory::new("ancestor-reparse");
        let target = root.0.join("target");
        let link = root.0.join("linked-parent");
        fs::create_dir(&target).unwrap();
        if symlink_dir(&target, &link).is_err() {
            return;
        }

        let error = StableDirectory::open_or_create(link.join("cache-v1"))
            .expect_err("完整祖先链中的 reparse point 必须被拒绝");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[cfg(windows)]
    #[test]
    fn directory_guard_prevents_ancestor_rename_until_the_lease_is_dropped() {
        let root = TestDirectory::new("directory-guard");
        let updater = root.0.join("updater");
        let cache = updater.join("cache-v1");
        fs::create_dir(&updater).unwrap();
        fs::create_dir(&cache).unwrap();
        let lease = StableDirectory::open_existing(&cache)
            .unwrap()
            .expect("cache 应存在");

        fs::rename(&updater, root.0.join("moved"))
            .expect_err("祖先 no-share-delete guard 存活时不得被重命名");
        drop(lease);
        fs::rename(&updater, root.0.join("moved")).expect("释放完整祖先链后应允许重命名");
    }

    #[cfg(windows)]
    #[test]
    fn regular_read_uses_one_no_follow_handle_and_denies_replacement() {
        let root = TestDirectory::new("read-guard");
        fs::write(root.0.join("installer.exe"), b"verified").unwrap();
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        let mut file = directory
            .open_regular_read(OsStr::new("installer.exe"))
            .unwrap()
            .expect("installer 应存在");

        fs::rename(root.0.join("installer.exe"), root.0.join("installer.old"))
            .expect_err("读取 handle 存活时不得替换 installer");
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"verified");
        drop(file);
        fs::rename(root.0.join("installer.exe"), root.0.join("installer.old"))
            .expect("释放读取 handle 后应允许重命名");
    }

    #[cfg(windows)]
    #[test]
    fn remove_regular_never_follows_a_file_reparse_point() {
        use std::os::windows::fs::symlink_file;

        let root = TestDirectory::new("leaf-reparse");
        let outside = root.0.join("outside.bin");
        let link = root.0.join("installer.part");
        fs::write(&outside, b"outside").unwrap();
        if symlink_file(&outside, &link).is_err() {
            return;
        }
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");

        directory
            .remove_regular(OsStr::new("installer.part"))
            .expect_err("清理不能跟随 reparse point");
        assert_eq!(fs::read(outside).unwrap(), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn replace_never_follows_an_existing_file_reparse_point() {
        use std::os::windows::fs::symlink_file;

        let root = TestDirectory::new("replace-reparse");
        let outside = root.0.join("outside.json");
        let link = root.0.join("policy.json");
        fs::write(&outside, b"outside").unwrap();
        if symlink_file(&outside, &link).is_err() {
            return;
        }
        let directory = StableDirectory::open_existing(&root.0)
            .unwrap()
            .expect("测试目录应存在");
        let mut replacement = directory
            .create_new_renameable(OsStr::new("policy.tmp"))
            .unwrap();
        replacement.write_all(b"new").unwrap();
        replacement.sync_all().unwrap();

        directory
            .publish_replace(
                &replacement,
                OsStr::new("policy.tmp"),
                OsStr::new("policy.json"),
            )
            .expect_err("replace 不能跟随现有 reparse point");
        drop(replacement);

        assert_eq!(fs::read(outside).unwrap(), b"outside");
        assert_eq!(fs::read(root.0.join("policy.tmp")).unwrap(), b"new");
    }
}
