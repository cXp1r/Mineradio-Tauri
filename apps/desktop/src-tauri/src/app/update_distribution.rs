pub(crate) const OFFICIAL_DISTRIBUTION_ENV: &str = "MINERADIO_OFFICIAL_DISTRIBUTION";
pub(crate) const COMPILED_DISTRIBUTION_ENV: &str = "MINERADIO_COMPILED_UPDATE_DISTRIBUTION";
pub(crate) const OFFICIAL_DISTRIBUTION_REQUEST: &str = "github-release-v1";
pub(crate) const OFFICIAL_DISTRIBUTION_TARGET: &str = "x86_64-pc-windows-msvc";
const DISABLED_DISTRIBUTION_MARKER: &str = "disabled";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DistributionBuildMode {
    Disabled,
    OfficialGithubReleaseV1,
}

impl DistributionBuildMode {
    pub(crate) const fn compiled_marker(self) -> &'static str {
        match self {
            Self::Disabled => DISABLED_DISTRIBUTION_MARKER,
            Self::OfficialGithubReleaseV1 => OFFICIAL_DISTRIBUTION_REQUEST,
        }
    }
}

/// 只有这个模块能构造正式发行 capability。后续 updater bootstrap 必须持有它，
/// 才能创建 GitHub source、下载器与安装协调器。
#[derive(Clone, Copy, Debug)]
pub(crate) struct OfficialUpdateDistribution {
    _private: (),
}

pub(crate) fn classify_build_request(
    requested: Option<&str>,
    target: &str,
) -> DistributionBuildMode {
    if requested == Some(OFFICIAL_DISTRIBUTION_REQUEST) && target == OFFICIAL_DISTRIBUTION_TARGET {
        DistributionBuildMode::OfficialGithubReleaseV1
    } else {
        DistributionBuildMode::Disabled
    }
}

fn classify_compiled_marker(marker: Option<&str>) -> DistributionBuildMode {
    if marker == Some(OFFICIAL_DISTRIBUTION_REQUEST) {
        DistributionBuildMode::OfficialGithubReleaseV1
    } else {
        DistributionBuildMode::Disabled
    }
}

pub(crate) fn compiled_official_distribution() -> Option<OfficialUpdateDistribution> {
    match classify_compiled_marker(option_env!("MINERADIO_COMPILED_UPDATE_DISTRIBUTION")) {
        DistributionBuildMode::OfficialGithubReleaseV1 => {
            Some(OfficialUpdateDistribution { _private: () })
        }
        DistributionBuildMode::Disabled => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_release_request_on_windows_x64_msvc_enables_official_distribution() {
        assert_eq!(
            classify_build_request(
                Some(OFFICIAL_DISTRIBUTION_REQUEST),
                OFFICIAL_DISTRIBUTION_TARGET,
            ),
            DistributionBuildMode::OfficialGithubReleaseV1
        );
    }

    #[test]
    fn absent_or_empty_release_request_stays_disabled() {
        for requested in [None, Some("")] {
            assert_eq!(
                classify_build_request(requested, OFFICIAL_DISTRIBUTION_TARGET),
                DistributionBuildMode::Disabled
            );
        }
    }

    #[test]
    fn near_match_release_request_stays_disabled() {
        for requested in ["github-release", "github-release-v1 ", "GitHub-release-v1"] {
            assert_eq!(
                classify_build_request(Some(requested), OFFICIAL_DISTRIBUTION_TARGET),
                DistributionBuildMode::Disabled
            );
        }
    }

    #[test]
    fn official_request_on_any_other_target_stays_disabled() {
        for target in [
            "aarch64-pc-windows-msvc",
            "x86_64-pc-windows-gnu",
            "x86_64-unknown-linux-gnu",
        ] {
            assert_eq!(
                classify_build_request(Some(OFFICIAL_DISTRIBUTION_REQUEST), target),
                DistributionBuildMode::Disabled
            );
        }
    }

    #[test]
    fn compiled_marker_is_also_exact_and_fail_closed() {
        assert_eq!(
            classify_compiled_marker(Some(OFFICIAL_DISTRIBUTION_REQUEST)),
            DistributionBuildMode::OfficialGithubReleaseV1
        );
        for marker in [None, Some(""), Some("github-release-v2"), Some("disabled")] {
            assert_eq!(
                classify_compiled_marker(marker),
                DistributionBuildMode::Disabled
            );
        }
    }
}
