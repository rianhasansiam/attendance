# Report fonts

PDF reports embed Hind Siliguri Regular and Bold for English and Bangla text.

- Upstream: https://github.com/google/fonts/tree/main/ofl/hindsiliguri
- Copyright: Indian Type Foundry, 2015
- License: SIL Open Font License 1.1, included in `OFL.txt`

The font files are bundled locally so report generation does not need a network request.

Chinese report text uses **Noto Sans CJK SC Regular**. Mixed lines retain Hind Siliguri for Latin/Bengali and switch only CJK runs, preserving user-entered text in all three scripts.

- Upstream: https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese
- Copyright: Adobe, with Reserved Font Name Source
- License: SIL Open Font License 1.1, included in `NotoSansCJK-LICENSE.txt`
- Server PDF asset only; the application UI uses system font fallbacks.
