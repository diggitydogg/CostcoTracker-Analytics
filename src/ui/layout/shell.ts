/**
 * Page shell classes shared by every top-level screen (cloud, local file).
 *
 * - The page is bounded (max-w-page) and centered, so very large windows keep
 *   content where people look instead of stretching it edge to edge.
 * - Margins never go inside the safe area (notches, side-placed system bars
 *   on some devices, the home indicator), as Apple's Layout guidance requires.
 * - `<main>` is a size container: every region inside decides its layout from
 *   the width it actually has (container queries), never from the device,
 *   the screen or the orientation.
 */
export const pageRow = 'mx-auto w-full max-w-page page-gutter'
export const pageHeader = 'safe-top border-b border-slate-200 bg-white'
export const pageMain = `${pageRow} @container flex-1 py-6`
export const pageFooter = 'page-gutter border-t border-slate-200 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-slate-500'
