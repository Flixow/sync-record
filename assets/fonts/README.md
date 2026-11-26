# Caption fonts

| File | Font | Version | Weight |
| --- | --- | --- | --- |
| `NotoSans-Regular.ttf` | Noto Sans | 2.004 | 400 |
| `NotoSans-Bold.ttf` | Noto Sans | 2.004 | 700 |

Noto Sans is © Google LLC (Noto Project) and licensed under the SIL Open Font License 1.1: the full text is in `OFL.txt`.
The files are the unmodified static TrueType fonts. They cover Latin, Latin Extended (all Polish letters: ą ć ę ł ń ó ś ź ż and capitals), Cyrillic and Greek.

The burned-in captions name only this family. The ffmpeg `ass` filter is given this directory as `fontsdir` (see `captionFilter` in `src/shared/captions.ts`), so libass loads the faces from here and the result does not depend on fonts installed on the host.
libass also tries to read `OFL.txt` and this file as fonts and reports that at debug log level only; it is harmless.
