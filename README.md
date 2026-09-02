# Elevated (WebGL port)

A source-faithful JavaScript, WebGL 2 and Web Audio port of **Elevated** by TBC
and RGBA, the winning 4k intro at Breakpoint 2009.

The port preserves the packed timeline, shared x86 random stream, procedural
x87 synth graph, five original shader passes, the 1024-segment HQ terrain
tessellation, and the release's projection, sampling and motion-blur constants.
It runs to sample `0x910000`, matching the release executable rather than the
shorter debug driver.

Original music by Puryx (Christian Rønde), visuals by iq (Inigo Quilez), and
sound synthesizer and code optimization by Mentor (Rune L. H. Stubbe). The
original source is licensed under
[CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).

This port was made with Codex 5.6 Sol Ultra.
