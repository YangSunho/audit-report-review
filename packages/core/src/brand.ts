// 앱 정체성 — 화면·보고서·엑셀 어디에 표시하든 같은 문구를 쓰도록 한 곳에 둔다.
// 버전을 여러 파일에 흩어 두면 반드시 어긋난다.

export const APP_NAME = "ARI";
export const APP_FULL_NAME = "ARI — Audit Review Intelligence";
export const APP_VERSION = "1.0.0";
/** 배포일 (YYYY-MM-DD). 릴리스할 때 이 줄만 고친다. */
export const APP_RELEASED = "2026-07-29";
export const AUTHOR = "양선호 (Yang, Sunho)";
export const COPYRIGHT_YEAR = "2026";
export const LICENSE = "MIT License";

/** "ARI 감사보고서 검토 v1.0.0 (2026-07-29)" */
export const APP_TITLE_VERSION = `${APP_NAME} 감사보고서 검토 v${APP_VERSION} (${APP_RELEASED})`;

/** 한 줄 크레딧 (평문). */
export function creditLine(): string {
  return `© ${COPYRIGHT_YEAR} ${AUTHOR} · ${APP_TITLE_VERSION} · 모든 처리는 사용자 PC에서 수행 · ${LICENSE}`;
}
