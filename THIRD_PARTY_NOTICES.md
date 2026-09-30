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
