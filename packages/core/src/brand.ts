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

/**
 * 화면에 싣는 면책 문구.
 *
 * WHY: 하단에 "MIT License" 라고만 쓰면 이 도구를 쓰는 회계사에게 아무 의미가
 * 없다. MIT 조항의 실질은 (1) 자유로운 사용·수정·재배포 허용과 (2) 무보증·무책임
 * 이며, 감사 도구에서 정작 중요한 것은 (2)다. 그래서 영문 라이선스 이름 대신
 * 그 취지를 한국어로 명시한다. 법적 근거인 LICENSE 파일은 그대로 둔다.
 */
export const DISCLAIMER =
  "본 도구는 감사인의 검토를 보조합니다. 감사 판단과 조서 작성의 책임은 사용자에게 있습니다. " +
  "MIT 라이선스로 제공되며 어떠한 보증도 하지 않습니다.";

/** "ARI 감사보고서 검토 v1.0.0 (2026-07-29)" */
export const APP_TITLE_VERSION = `${APP_NAME} 감사보고서 검토 v${APP_VERSION} (${APP_RELEASED})`;

/** 한 줄 크레딧 (평문). */
export function creditLine(): string {
  return `© ${COPYRIGHT_YEAR} ${AUTHOR} · ${APP_TITLE_VERSION} · ${DISCLAIMER}`;
}
