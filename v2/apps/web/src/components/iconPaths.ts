// Ported verbatim from design/eazystores/source/lib.py (the approved icon set: 24px viewBox, stroke 1.6, round caps). Add new icons only in the same style.
export const ICONS: Record<string, string> = {
 "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.5-3.5\"/>",
 "heart": "<path d=\"M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z\"/>",
 "bag": "<path d=\"M5 8h14l-1 12H6L5 8z\"/><path d=\"M9 8a3 3 0 0 1 6 0\"/>",
 "user": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c1-4 4-6 8-6s7 2 8 6\"/>",
 "home": "<path d=\"M4 11l8-7 8 7v9H4z\"/>",
 "grid": "<rect x=\"4\" y=\"4\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13\" y=\"4\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"4\" y=\"13\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13\" y=\"13\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
 "cam": "<path d=\"M4 8h3l2-3h6l2 3h3v11H4z\"/><circle cx=\"12\" cy=\"13\" r=\"3.5\"/>",
 "plus": "<path d=\"M12 5v14M5 12h14\"/>",
 "check": "<path d=\"M5 12l5 5 9-10\"/>",
 "chev": "<path d=\"M9 6l6 6-6 6\"/>",
 "truck": "<path d=\"M3 6h11v10H3zM14 10h4l3 3v3h-7\"/><circle cx=\"7\" cy=\"18\" r=\"1.8\"/><circle cx=\"17\" cy=\"18\" r=\"1.8\"/>",
 "shield": "<path d=\"M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z\"/><path d=\"M8.5 12l2.5 2.5 4.5-5\"/>",
 "msg": "<path d=\"M4 5h16v11H9l-5 4z\"/>",
 "box": "<path d=\"M4 8l8-4 8 4v9l-8 4-8-4z\"/><path d=\"M4 8l8 4 8-4M12 12v9\"/>",
 "tag": "<path d=\"M3 12V4h8l10 10-8 8z\"/><circle cx=\"7.5\" cy=\"8.5\" r=\"1.3\"/>",
 "chart": "<path d=\"M4 20V10M10 20V4M16 20v-8M22 20H2\"/>",
 "wallet": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"3\"/><path d=\"M16 12h5\"/>",
 "store": "<path d=\"M4 9l2-5h12l2 5M4 9h16v11H4zM9 20v-6h6v6\"/>"
};
export type IconName = "search" | "heart" | "bag" | "user" | "home" | "grid" | "cam" | "plus" | "check" | "chev" | "truck" | "shield" | "msg" | "box" | "tag" | "chart" | "wallet" | "store";
