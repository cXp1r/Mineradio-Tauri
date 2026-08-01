import type { ComponentProps, ReactElement } from "react";
import { SearchDetailPage } from "../../components/shell/SearchDetailPage";
import { SearchShell } from "../../components/shell/SearchShell";
import { EmptyHomeHost } from "../../home/EmptyHomeHost";

export interface HomeSurfaceProps {
  homeProps: ComponentProps<typeof EmptyHomeHost>;
  searchProps: ComponentProps<typeof SearchShell>;
  searchDetailProps: ComponentProps<typeof SearchDetailPage>;
}

export function HomeSurface({
  homeProps,
  searchProps,
  searchDetailProps,
}: HomeSurfaceProps): ReactElement {
  return (
    <>
      <EmptyHomeHost {...homeProps} />
      <SearchShell {...searchProps} />
      <SearchDetailPage {...searchDetailProps} />
    </>
  );
}
