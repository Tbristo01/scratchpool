#!/usr/bin/env python3
"""Convert an asciinema v2 cast into a self-contained animated SVG.

Zero dependencies (Python 3.8+ standard library only). The output works as an
<img> in a GitHub README: no <script>, no external fonts or images, animation is
a single CSS @keyframes rule that steps a vertical film strip of frames.

How it works:
  1. A minimal terminal emulator replays the cast: printable text, \\r, \\n, \\b,
     line wrap and scrolling, ESC[K / ESC[J erase, ESC[nA/B/C/D/G/H cursor moves
     and ESC[...m colours (bold, 16/256/truecolor foreground). Anything else
     (cursor show/hide, OSC titles, ...) is ignored.
  2. Screen state is sampled on a fixed time grid so the frame count stays under
     --max-frames; rapid updates (typing, spinners) inside one slot merge, and
     identical consecutive frames are dropped. Long idle gaps are capped.
  3. Each frame is rendered as rows of <text>. Identical rows are defined once
     in <defs> and reused with <use>, which keeps the file small.

Usage:
  python3 scripts/cast-to-svg.py docs/demo/scratchpool-demo.cast docs/demo/scratchpool-demo.svg
  python3 scripts/cast-to-svg.py demo.cast --text            # print the final screen as text
  python3 scripts/cast-to-svg.py demo.cast --text --at 20    # screen at t=20 s (cast time)

Email-shaped strings (scratch org usernames) are masked by default; pass
--keep-emails to leave them as recorded. Salesforce org IDs (00D...) are always masked.
Masking is per event, so a value split across two events is not caught: redact the cast
itself first (scripts/record-demo.py does this over the joined output).
"""
import argparse
import json
import re
import sys
from xml.sax.saxutils import escape

# ---------------------------------------------------------------- palette ---
BG = "#0d1117"
CHROME = "#161b22"
BORDER = "#30363d"
FG = "#c9d1d9"
TITLE_FG = "#8b949e"
CURSOR = "#c9d1d9"
ANSI = [
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",  # 30-37
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",  # 90-97
]

FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
FONT_SIZE = 14
CHAR_W = FONT_SIZE * 0.6          # advance width of common monospace fonts
LINE_H = round(FONT_SIZE * 1.3)   # 18 px
PAD = 16
BAR_H = 34

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
ORG_ID_RE = re.compile(r"\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b")


def color256(n):
    if n < 16:
        return ANSI[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        r, g, b = steps[n // 36], steps[(n // 6) % 6], steps[n % 6]
        return "#%02x%02x%02x" % (r, g, b)
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


# --------------------------------------------------------------- terminal ---
class Terminal:
    """Just enough VT100 to replay CLI output, spinners and prompts."""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.blank = (" ", None, False)
        self.grid = [[self.blank] * cols for _ in range(rows)]
        self.x = self.y = 0
        self.fg, self.bold = None, False
        self.pending = ""  # incomplete escape sequence carried between events

    # -- helpers
    def _scroll(self):
        self.grid.pop(0)
        self.grid.append([self.blank] * self.cols)

    def _newline(self):
        self.y += 1
        if self.y >= self.rows:
            self._scroll()
            self.y = self.rows - 1

    def _put(self, ch):
        if self.x >= self.cols:  # deferred wrap
            self.x = 0
            self._newline()
        self.grid[self.y][self.x] = (ch, self.fg, self.bold)
        self.x += 1

    def _sgr(self, params):
        nums = [int(p) if p.isdigit() else 0 for p in (params.split(";") if params else ["0"])]
        i = 0
        while i < len(nums):
            n = nums[i]
            if n == 0:
                self.fg, self.bold = None, False
            elif n == 1:
                self.bold = True
            elif n == 22:
                self.bold = False
            elif 30 <= n <= 37:
                self.fg = ANSI[n - 30]
            elif 90 <= n <= 97:
                self.fg = ANSI[n - 90 + 8]
            elif n == 39:
                self.fg = None
            elif n == 38 and i + 1 < len(nums):
                if nums[i + 1] == 5 and i + 2 < len(nums):
                    self.fg = color256(nums[i + 2])
                    i += 2
                elif nums[i + 1] == 2 and i + 4 < len(nums):
                    self.fg = "#%02x%02x%02x" % tuple(nums[i + 2:i + 5])
                    i += 4
            # backgrounds, italics, underline, etc. are ignored
            i += 1

    def _csi(self, params, final):
        if params.startswith("?"):
            return  # private modes (cursor show/hide, bracketed paste...)
        p = params.split(";") if params else []
        n = int(p[0]) if p and p[0].isdigit() else 0
        m = max(n, 1)
        if final == "m":
            self._sgr(params)
        elif final == "A":
            self.y = max(0, self.y - m)
        elif final == "B":
            self.y = min(self.rows - 1, self.y + m)
        elif final == "C":
            self.x = min(self.cols - 1, self.x + m)
        elif final == "D":
            self.x = max(0, min(self.x, self.cols) - m)
        elif final == "G":
            self.x = min(self.cols - 1, m - 1)
        elif final in "Hf":
            row = int(p[0]) if p and p[0].isdigit() else 1
            col = int(p[1]) if len(p) > 1 and p[1].isdigit() else 1
            self.y = min(self.rows - 1, max(0, row - 1))
            self.x = min(self.cols - 1, max(0, col - 1))
        elif final == "K":
            row = self.grid[self.y]
            x = min(self.x, self.cols)
            if n == 0:
                row[x:] = [self.blank] * (self.cols - x)
            elif n == 1:
                row[:x + 1] = [self.blank] * (x + 1)
            else:
                self.grid[self.y] = [self.blank] * self.cols
        elif final == "J":
            if n == 0:
                self._csi("", "K")
                for r in range(self.y + 1, self.rows):
                    self.grid[r] = [self.blank] * self.cols
            elif n == 1:
                for r in range(0, self.y):
                    self.grid[r] = [self.blank] * self.cols
            else:
                self.grid = [[self.blank] * self.cols for _ in range(self.rows)]

    def feed(self, data):
        s = self.pending + data
        self.pending = ""
        i, n = 0, len(s)
        while i < n:
            c = s[i]
            if c == "\x1b":
                if i + 1 >= n:
                    self.pending = s[i:]
                    return
                nxt = s[i + 1]
                if nxt == "[":
                    j = i + 2
                    while j < n and not ("@" <= s[j] <= "~"):
                        j += 1
                    if j >= n:
                        self.pending = s[i:]
                        return
                    self._csi(s[i + 2:j], s[j])
                    i = j + 1
                    continue
                if nxt == "]":  # OSC: skip to BEL or ST
                    j = i + 2
                    while j < n and s[j] != "\x07" and s[j:j + 2] != "\x1b\\":
                        j += 1
                    if j >= n:
                        self.pending = s[i:]
                        return
                    i = j + (1 if s[j] == "\x07" else 2)
                    continue
                i += 2  # other two-byte escapes: ignore
                continue
            if c == "\r":
                self.x = 0
            elif c == "\n":
                self._newline()
            elif c == "\b":
                self.x = max(0, self.x - 1)
            elif c == "\t":
                self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif c >= " " and c != "\x7f":
                self._put(c)
            i += 1

    def snapshot(self):
        return (tuple(tuple(r) for r in self.grid), (min(self.x, self.cols - 1), self.y))

    def text(self):
        return "\n".join("".join(c[0] for c in r).rstrip() for r in self.grid).rstrip("\n")


# ---------------------------------------------------------------- framing ---
def load_cast(path, keep_emails):
    with open(path, encoding="utf-8") as f:
        header = json.loads(f.readline())
        if header.get("version") != 2:
            sys.exit("only asciinema v2 casts are supported")
        events = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            t, kind, data = json.loads(line)
            if kind != "o":
                continue
            if not keep_emails:
                data = EMAIL_RE.sub("<username>", data)
            data = ORG_ID_RE.sub("00D000000000000AAA", data)
            events.append((float(t), data))
    return header, events


def compress_idle(events, idle_cap):
    out, prev_raw, shift = [], 0.0, 0.0
    for t, d in events:
        gap = t - prev_raw
        if idle_cap and gap > idle_cap:
            shift += gap - idle_cap
        prev_raw = t
        out.append((t - shift, d))
    return out


def build_frames(header, events, max_frames, max_seconds, hold):
    term = Terminal(header["width"], header["height"])
    if not events:
        return [(0.0, term.snapshot())], hold
    end = events[-1][0]
    scale = min(1.0, (max_seconds - hold) / end) if end > 0 else 1.0
    slot = max(end * scale / max(max_frames - 1, 1), 0.05)
    frames = [(0.0, term.snapshot())]
    i = 0
    k = 1
    while i < len(events):
        boundary = k * slot
        while i < len(events) and events[i][0] * scale < boundary:
            term.feed(events[i][1])
            i += 1
        snap = term.snapshot()
        if snap != frames[-1][1]:
            frames.append((min(boundary, end * scale), snap))
        k += 1
    total = frames[-1][0] + hold
    return frames, total


def frames_at(header, events, at):
    term = Terminal(header["width"], header["height"])
    for t, d in events:
        if at is not None and t > at:
            break
        term.feed(d)
    return term


# ---------------------------------------------------------------- render ----
def render_row(cells):
    """Return SVG markup for one row (a <text> at y=0) or None if blank."""
    last = len(cells)
    while last and cells[last - 1][0] == " ":
        last -= 1
    if not last:
        return None
    runs, cur, buf = [], None, []
    for ch, fg, bold in cells[:last]:
        style = (fg, bold)
        if style != cur and buf:
            runs.append((cur, "".join(buf)))
            buf = []
        cur = style
        buf.append(ch)
    runs.append((cur, "".join(buf)))
    parts = []
    for (fg, bold), txt in runs:
        attrs = ""
        if fg:
            attrs += ' fill="%s"' % fg
        if bold:
            attrs += ' font-weight="700"'
        txt = escape(txt)
        parts.append("<tspan%s>%s</tspan>" % (attrs, txt) if attrs else txt)
    return "<text>%s</text>" % "".join(parts)


def fmt(v):
    s = ("%.3f" % v).rstrip("0").rstrip(".")
    return s or "0"


def render_svg(header, frames, total):
    cols, rows = header["width"], header["height"]
    term_w = (cols + 1) * CHAR_W  # one column of slack for fonts slightly wider than 0.6em
    term_h = rows * LINE_H
    width = round(term_w + 2 * PAD)
    height = round(term_h + BAR_H + PAD + 8)
    title = escape(header.get("title") or "terminal")

    defs, ids = [], {}
    strip = []
    for idx, (_, (grid, (cx, cy))) in enumerate(frames):
        y0 = idx * term_h
        uses = []
        for r, cells in enumerate(grid):
            markup = render_row(cells)
            if markup is None:
                continue
            if markup not in ids:
                ids[markup] = "r%d" % len(ids)
                defs.append('<g id="%s">%s</g>' % (ids[markup], markup))
            uses.append('<use xlink:href="#%s" y="%s"/>' % (ids[markup], fmt(y0 + r * LINE_H)))
        uses.append('<rect class="c" x="%s" y="%s" width="%s" height="%s"/>' % (
            fmt(cx * CHAR_W), fmt(y0 + cy * LINE_H - FONT_SIZE + 2), fmt(CHAR_W), fmt(LINE_H - 1)))
        strip.append("".join(uses))

    kf = []
    for idx, (t, _) in enumerate(frames):
        kf.append("%s%%{transform:translateY(%spx)}" % (fmt(t / total * 100), fmt(-idx * term_h)))
    if not frames or frames[0][0] > 0:
        kf.insert(0, "0%{transform:translateY(0)}")

    css = (
        "text{font-family:%s;font-size:%dpx;fill:%s;white-space:pre}"
        ".c{fill:%s;opacity:.6}"
        ".s{animation:k %ss step-end infinite}"
        "@keyframes k{%s}"
        "@media (prefers-reduced-motion:reduce){.s{animation:none;transform:translateY(%spx)}}"
    ) % (FONT, FONT_SIZE, FG, CURSOR, fmt(total), "".join(kf), fmt(-(len(frames) - 1) * term_h))

    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'xml:space="preserve" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-label="%s">'
        % (width, height, width, height, title),
        "<title>%s</title>" % title,
        "<style>%s</style>" % css,
        "<defs>%s</defs>" % "".join(defs),
        '<rect x=".5" y=".5" width="%d" height="%d" rx="10" fill="%s" stroke="%s"/>' % (width - 1, height - 1, BG, BORDER),
        '<path d="M.5 10.5a10 10 0 0 1 10-10h%d a10 10 0 0 1 10 10v%dH.5z" fill="%s"/>' % (width - 21, BAR_H - 10, CHROME),
        '<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/>'
        '<circle cx="60" cy="17" r="6" fill="#28c840"/>',
        '<text x="%s" y="22" text-anchor="middle" style="font-size:12px;fill:%s">%s</text>' % (fmt(width / 2), TITLE_FG, title),
        '<svg x="%d" y="%d" width="%s" height="%s" overflow="hidden">' % (PAD, BAR_H + 8, fmt(term_w), fmt(term_h)),
        '<g transform="translate(0 %d)"><g class="s">%s</g></g>' % (FONT_SIZE, "".join(strip)),
        "</svg></svg>",
    ]
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cast")
    ap.add_argument("svg", nargs="?", help="output path (omit with --text)")
    ap.add_argument("--max-frames", type=int, default=120)
    ap.add_argument("--max-seconds", type=float, default=60.0, help="loop length cap, including the hold")
    ap.add_argument("--hold", type=float, default=4.0, help="seconds to hold the last frame")
    ap.add_argument("--idle-cap", type=float, default=3.0, help="cap pauses longer than this (0 = off)")
    ap.add_argument("--keep-emails", action="store_true", help="do not mask email-shaped usernames")
    ap.add_argument("--text", action="store_true", help="print the screen as plain text instead")
    ap.add_argument("--at", type=float, default=None, help="with --text: cast time in seconds (default: end)")
    args = ap.parse_args()

    header, events = load_cast(args.cast, args.keep_emails)
    if args.text:
        print(frames_at(header, events, args.at).text())
        return
    if not args.svg:
        ap.error("an output path is required unless --text is given")
    events = compress_idle(events, args.idle_cap)
    frames, total = build_frames(header, events, args.max_frames, args.max_seconds, args.hold)
    svg = render_svg(header, frames, total)
    with open(args.svg, "w", encoding="utf-8") as f:
        f.write(svg)
    print("%s: %d frames, %.1f s loop, %d bytes" % (args.svg, len(frames), total, len(svg.encode("utf-8"))))


if __name__ == "__main__":
    main()
