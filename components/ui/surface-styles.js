// Shared console/studio surfaces. Keep literal classes here so Tailwind sees
// them and both screens inherit the same radius, border, depth, and states.
export const WELL = 'rounded-[13px] border border-white/[0.05] bg-[#141414]';
export const RAISED = 'bg-[#222222] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4)]';
export const CARD = `${WELL} text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4)]`;
export const POPOVER = `${WELL} shadow-[0_8px_24px_rgba(0,0,0,0.55)]`;
// The console dropdown's raised hover surface, also used by Studio pills.
export const RAISED_HOVER = 'hover:bg-[#222222] hover:text-[#f0f0f0] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4)]';
// Studio controls retain their raised edge at rest; interaction darkens the
// fill. Keep the console dropdown's RAISED_HOVER above unchanged.
const DARKEN = 'hover:bg-[#141414] hover:text-[#f0f0f0] active:bg-[#101010] focus-visible:bg-[#141414] focus-visible:text-[#f0f0f0]';
export const CONTROL = `rounded-[13px] border border-white/[0.05] ${RAISED} ${DARKEN} text-[#d4d4d4] transition-[color,background-color,box-shadow] duration-150 ease-out focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50`;
export const ITEM = `rounded-[10px] ${RAISED} ${DARKEN} text-[#9a9a9a] transition-[color,background-color,box-shadow] duration-150 ease-out`;
