# P7 图片处理提示词记录

模式：内置 imagegen，两次局部编辑，均要求真实透明背景。未使用API key、未运行付费聊天模型SDK，也未用Python或其他脚本修改像素。原图只读，选中输出复制到本Worktree的desktop/local-preview；该目录不进入Git或现有portable分发目录。

## 1. 透明主体

输入1为用户的完整Q版角色图；输入2为三视图辅助参考。两者的路径／SHA见ASSET_PROVENANCE.md。

完整提示词：

> Use case: identity-preserve / background-extraction. Asset type: clean transparent PNG character cutout for a local-only Windows desktop pet preview. Image 1 is the primary EDIT TARGET: preserve its cute chibi proportions, original hand-drawn anime linework, colors, full-body standing pose and expression as closely as possible. Image 2 is a supporting character-design reference ONLY; do not copy its screenshot UI. Produce ONE full-body front-facing DeepSeek-girl character centered on genuine transparent alpha with comfortable transparent padding on all edges, not a checkerboard illustration. Keep the entire blue-gradient long hair, blue eyes, navy and white frilled maid dress with apron, whale-shaped tail curling out on the viewer's right, frilled headpiece, blue hair bow, chest bow, gold details and shoes. Preserve the large rounded head/body proportions from image 1. Precisely remove only the white/gray screenshot background. No player controls, text, labels, side/back views, other characters, platform buttons, square background, cast shadow, new props or watermark. This is a faithful isolated character asset, not a redesign or poster. Save with real transparency; do not flatten to white.

选中输出：desktop/local-preview/deepseek-open.png。工具原始输出保留于D:/CodexData/generated_images/01a1950b-0d67-7533-bbb1-43ea0af839fa/exec-1733f781-d709-42d6-8e9b-61fbc4a8b8c4.png，没有覆盖或删除。

## 2. 闭眼帧

输入为上一步已实际查看的透明主体，transparent_background=true。

完整提示词：

> Use case: precise-object-edit. This is the EDIT TARGET and should be preserved, not redesigned. Make a single blink frame for an animated desktop pet from this transparent PNG. Keep the EXACT same image dimensions, character scale, pixel alignment, hair silhouette, head position, mouth, body pose, hands, maid dress, bows, whale tail, shoes, linework, colors and alpha boundaries. The ONLY change is to close both blue eyes into natural softly curved relaxed eyelids with matching dark blue eyelashes, as a brief gentle blink. Keep eyebrows and mouth unchanged. Do not tilt the head, change expression or open the mouth differently. No background, checkerboard, text, screenshot controls, additional characters, frame border or new props. Preserve transparent alpha; center and framing precisely match the input. A pixel-aligned closed-eyes counterpart of the same complete character, not a new pose.

选中输出：desktop/local-preview/deepseek-blink.png。原始输出保留于D:/CodexData/generated_images/01a1950b-0d67-7533-bbb1-43ea0af839fa/exec-fa4090de-b206-4f59-8790-19376b3c0461.png。

提示词中的“只改眼睛”是生成约束，不是结果保证。实际QA发现眼外色值仍有变化，因此程序只使用闭眼帧眼部区域，不能将整帧视为像素完全一致的动画。没有独立尾巴图层，独立摇尾巴留待后续可靠分层制作；本轮不以全身晃动冒充。

本地预览不代表获得角色、图片、商标或商业分发许可。没有与DeepSeek官方合作／授权的声明。
