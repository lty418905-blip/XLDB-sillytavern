# 第三方宣告

XLDB 自有且未另行許可的部分適用 [自訂許可](LICENSE.md). 以下部分保持其原有許可證.

## OpenHer

- 來源:https://github.com/kellyvv/OpenHer
- 固定版本:`ef5b2145c9c15582499ecc5fb9d10376d82eccdf`
- Copyright 2026 OpenHer Contributors
- 許可證:Apache-2.0; 隨附上游文本:[third-party/OpenHer-LICENSE](shared/third-party/OpenHer-LICENSE).
- 適用檔案:`shared/src/emotion/neural.ts`,`shared/src/emotion/openher.ts`, 遵循檔案已有許可宣告.
- XLDB 修改包括 TypeScript 移植, 顯式時鐘, 可序列化確定性隨機狀態, 事務及來源生命週期接線, 關係校準和有界歷史. 詳見 [採用說明](shared/docs/OPENHER_ADOPTION.md).

## 安裝時獲取的依賴

Node.js,LanceDB,TypeScript 及型別定義等依賴由安裝器獲取, 分別適用其分發包中的許可證. 基礎原始碼包不包含這些執行時, 依賴二進位制, 模型權重或使用者資料;AgentJev 擴充安裝包另附下述模型與執行時. 自訂許可不覆蓋任何第三方元件.

## AgentJev

- 原始碼:<https://github.com/malevrigns/agent-jev>, 固定版本 `a965ca8ff06ccabc0c796dca5447b55cc2069cee`,Apache-2.0, 許可全文見 `shared/third-party/agentjev/LICENSE`.
- 採用範圍:`agentjev/model.py`,`jev_service/contract.py`,`jev_service/prefix.py`.XLDB 修改骨幹初始化為本地設定構造, 完整權重只載入一次; 新增 `runner.py` 提供離線 CPU 管道呼叫. 未採用上游 HTTP 服務或訓練平臺.
- 模型:<https://huggingface.co/aimeigaoshou/agent-jev>, 固定版本 `e711cf4be8d1009458d2254f60df21738db8c6c0`, 上游模型卡標註 Apache-2.0; 保留模型卡和原始碼許可證. 權重 SHA-256 為 `a3c3503b71a04da0e30cbd17362f5733ba0a5ccae6d3eb5db7a84a2398a4953b`.
- Windows 擴充包附帶 Python 3.12.10,PyTorch 2.14.0 CPU,Transformers 5.16.1,Safetensors 0.8.0 及依賴, 各自沿用執行時目錄中的許可證及包後設資料. 它們只裝入專案 `.local/agentjev/`, 不修改全域環境.

## OpenCC 字元對照資料

- 來源:<https://github.com/BYVoid/OpenCC> 的 TSCharacters.txt, Apache-2.0. 原始資料 SHA-256: `9ff46a7d30e5765375eb13d33f2b03a34d298913caf2b120380679f33ae1642d`.
- 適用檔案:`shared/src/common/script-fold-data.ts`; 僅供比對副本使用. 測試的獨立字形參照資料亦源自該字表.
- XLDB 修改: 多候選取第一字, 補妳/著/祇/週/暱, 展開薴到苎的鏈; 排除 UTF-16 長度不同的對照, 保持原文索引. 不採用上游執行期或詞組轉換.
- 以下保留上游隨附的完整授權文本:

```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

   1. You must give any other recipients of the Work or Derivative Works a copy of this License; and

   2. You must cause any modified files to carry prominent notices stating that You changed the files; and

   3. You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

   4. If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```
