# XLDB for SillyTavern

XLDB 是一個 SillyTavern 外掛加上一個在你電腦上執行的本地核心，讓單角色或多 NPC 的跑團與角色扮演擁有連續的記憶、各自的情緒、角色知情範圍和劇情狀態。

> **目前狀態：開發快照，不是正式版。** 最後一個正式版本是 `tavern-v0.1.3-mvp`。本倉庫 `main` 分支目前是朝 0.2.0 開發中的快照，尚未打標籤，也未完成整套驗收。想要穩定使用請下載 [Releases](https://github.com/lty418905-blip/XLDB-sillytavern/releases) 中的正式版。

## 這是什麼

- **外掛**（`XLDB-酒馆.json` / `XLDB-酒馆.js`，原始碼在 `sillytavern/adapters/xldb.js`）：在酒館助手（Tavern Helper）中執行，負責連線、工作臺介面，以及在每次生成前向核心取得經過篩選的上下文。
- **本地核心**（`sillytavern/src`、`shared/src`）：由 `START-XLDB.cmd` 啟動，保存資料庫並處理每一輪已接受的正文。

主要功能：

- **NPC 記憶**：分開記錄事實與情景；每個角色只能記得自己看到、聽到或被告知的內容。外圍細節會隨時間自然模糊，重要事實與承諾受保留規則保護；之後提到相關線索時，模糊的記憶可以依原來的可見範圍被重新喚起。
- **OpenHer 情緒**：每個 NPC 有獨立的情緒狀態，由移植自 [OpenHer](https://github.com/kellyvv/OpenHer) 的神經情緒核心依已接受的事件更新，影響角色的表達。
- **劇情時間、世界狀態與承諾**：追蹤劇情時間、地點與物品等世界狀態，以及角色之間的約定與期限。
- **導演**（可選）：在工作臺啟用後，由後臺模型規劃劇情走向並給角色行動指引；可為導演單獨設定較強的模型。
- **工作臺**：檢視與糾正資料、恢復來源變化、查看各處理階段的狀態。

聊天正文仍由你在 SillyTavern 中選用的模型生成；XLDB 在生成前組裝經過篩選的上下文，並在你接受回覆後處理記憶、情緒與世界狀態。

### 與 XLDB（Agent）倉庫的關係

XLDB 有兩個入口，共用同一套核心程式（`shared/`）：

| 倉庫 | 內容 | 宿主 |
|---|---|---|
| [XLDB-sillytavern](https://github.com/lty418905-blip/XLDB-sillytavern)（本倉庫） | `shared/` + `sillytavern/` | SillyTavern |
| [XLDB](https://github.com/lty418905-blip/XLDB) | `shared/` + `companion-agent/` | 你自己的 Agent（伴侶與跑團） |

兩者的資料分開儲存，不會互通。

## 目前狀態

- **正式版本**：`tavern-v0.1.3-mvp`。
- **本倉庫 `main`**：朝 0.2.0 的開發快照（`package.json` 中標為 `0.2.0-mvp`，但尚未發佈）。已包含的變化見 [CHANGES.md](CHANGES.md)，包括新的目錄佈局、從 0.1.3 升級的流程、啟動器的首次確認與搬移提示、承諾期限解析修正，以及檢索設定的檢查與狀態顯示。
- **仍在開發中**（未完成前不要當作已提供的功能）：
  - 記憶修復與中英文記憶喚回的驗收；
  - 統一劇情時鐘：讓記憶保留與情緒共用同一個劇情時鐘，並依正文中的時間提示推進。核心邏輯已在程式碼中，但尚未接入外掛；
  - 判斷模型路線：可選的線上 Jev 判斷服務（見下方「設定」）屬於計劃，這個快照不包含；
  - 與 SillyTavern 原生提示組裝的共存（計劃在 0.3.0）。

## 需求

- Windows x64。
- SillyTavern 與已安裝的酒館助手（Tavern Helper）擴充；酒館與 XLDB 核心在同一臺電腦。
- Node.js 24.18.1 或以上的 24.x。沒有相容版本時，安裝器會下載並校驗便攜版本，不修改全域環境。
- 首次安裝需要網路。安裝 AgentJev 時請預留約 5 GB 可用空間。
- 一個 OpenAI 相容的聊天補全 API，給 XLDB 的後臺階段使用（見「設定」）。

## 安裝

完整步驟見 [INSTALL_TAVERN.md](INSTALL_TAVERN.md)。簡要流程：

1. 把完整目錄解壓到有寫入權限的位置，執行根目錄的 `START-XLDB.cmd`。
   - 啟動器會把依賴（LanceDB、TypeScript 等）安裝到本目錄的 `.local/`，啟動核心並開啟酒館頁面。
   - 在沒有執行記錄的資料夾第一次啟動時，會先列出將使用的私有目錄與資料目錄，按 `Y` 繼續。
   - 酒館不在預設的 `http://localhost:8000` 時：`START-XLDB.cmd -TavernOrigin http://localhost:埠`；要改核心埠時加 `-Port`。
2. 在酒館助手的腳本匯入介面選擇 `XLDB-酒馆.json` 並啟用（匯入後請確認開關已打開）。也可以新建腳本並貼上 `XLDB-酒馆.js` 的全部內容。兩種方式只啟用一種，並停用舊的 XLDB 腳本。
3. 在啟動器開啟的酒館頁面完成一次性配對。左下角的 **XLDB 连接** 按鈕可查看狀態與重新連線。
4. 在 XLDB 工作臺設定後臺文本模型的 API 地址、金鑰與模型；embedding 與 reranker 可選。

電腦重啟後重新執行 `START-XLDB.cmd` 即可。停止核心：

```powershell
powershell -ExecutionPolicy Bypass -File tools\stop.ps1
```

### AgentJev（本地模型，可選但建議）

同一輪有超過四名 NPC 需要更新情緒時，XLDB 用本地的 AgentJev 模型決定優先順序。

- 模型約 2.4 GB，便攜執行時約 160 MB，從 [XLDB（Agent）倉庫](https://github.com/lty418905-blip/XLDB/releases) 的 GitHub Release 下載並逐段校驗 SHA-256。
- 啟動器不會等待下載：首次啟動時在背景下載（每次啟動最多 600 秒，下次接著下載），核心先以降級模式執行，工作臺頂部顯示「情绪排序：本地规则（未安装 AgentJev）」之類的提示。模型就緒後自動改用 AgentJev，無須重啟。
- 一次在前臺下載完成：

  ```powershell
  powershell -ExecutionPolicy Bypass -File tools\install-agent-model.ps1
  ```

- 不想安裝：建立空檔案 `.local/agentjev/skip`；刪除它並重新執行啟動器即可恢復安裝。

### 從 0.1.3-mvp 升級

先停止舊核心並備份資料庫與私有目錄，再把新版覆蓋解壓到**同一個**安裝目錄，執行 `START-XLDB.cmd`，最後在酒館助手重新匯入新的 `XLDB-酒馆.json`。詳細步驟與回滾方式見 [INSTALL_TAVERN.md](INSTALL_TAVERN.md) 與 [RECOVERY.md](RECOVERY.md)。

## 設定與外部服務

XLDB 不內建任何金鑰。所有模型與 API 都由你在工作臺或自己的設定中填寫，金鑰保存在安裝目錄旁的私有目錄（預設為 `<安裝目錄名>-private`），不會隨程式分發。

| 用途 | 服務 | 送出的資料 |
|---|---|---|
| 聊天正文 | 你在 SillyTavern 中選用的模型 | XLDB 為本輪組裝、經過角色視角篩選的提示 |
| 後臺階段（記憶整理、情緒、世界狀態、承諾、導演等） | 你在工作臺設定的 OpenAI 相容聊天補全服務，例如 DeepSeek；可逐階段覆蓋 | 處理該階段所需的聊天正文、角色與世界資料 |
| 語義檢索與重排（可選） | 你設定的 embedding 與 reranker 服務，例如 SiliconFlow 上的 bge-m3 與 bge-reranker-v2-m3 | 當前查詢，以及該角色被允許檢索的記憶文本 |
| NPC 情緒排序（可選） | 本地 AgentJev | 不離開你的電腦；只有首次下載模型時連線 GitHub（XLDB 倉庫的 Release） |
| 線上 Jev 判斷（**計劃中**，此快照不包含） | 你自行設定時才使用的 OpenCode Zen Jev | 計劃：判斷所需的狀態文字 |

未設定 embedding 與 reranker 時，XLDB 使用本地 BM25 關鍵詞檢索；可以只設定其中一項。

## 隱私

- **資料存放在本機。** 資料庫預設在 `.local/data`，令牌、模型設定與配對資料在私有目錄。資料以明文保存，不加密；請不要把這兩個目錄上傳或分享。
- **送往模型服務的內容。** 你設定的後臺模型會收到處理各階段所需的聊天內容、角色卡與世界資料；SillyTavern 選用的正文模型會收到 XLDB 組裝的提示。這些服務如何處理資料，由服務提供方的政策決定。
- **送往檢索服務的內容。** 設定 embedding 或 reranker 後，查詢與允許檢索的記憶文本會送往你填寫的服務。
- **判斷服務（計劃中）。** 日後若加入並由你設定線上 Jev 判斷，判斷所需的狀態文字會送往 OpenCode Zen；設定頁會明示此事。
- **內容政策。** XLDB 不額外加入內容審查或題材限制；所用模型服務自有的內容政策照常適用。

## 已知限制

- 只支援 Windows x64；酒館與核心須在同一臺電腦。
- 受管聊天的正文提示由 XLDB 整段組裝：SillyTavern 預設中的系統提示、主提示、後置指令與作者注不會原樣進入正文模型；只支援對話補全（Chat Completion）；XLDB 生成期間，其他擴充以 `generateRaw` 發出的提示可能被清空。改為與 SillyTavern 原生組裝共存是 0.3.0 的計劃。
- 不支援群聊。
- 新聊天就是新 NPC：同一張角色卡開新聊天時，角色從頭認識你。要延續請回到原聊天。
- 酒館端配對不隨 XLDB 搬移；換電腦或換安裝位置後需要重新配對。私有目錄與檢索設定不在資料庫備份內，換機時須手動複製。
- 部分核心規則與外掛介面只有中文；英文場景的記憶喚回品質可能較低。
- NPC 情緒尚未接入統一劇情時鐘，情緒的時間代謝仍在開發中。
- 最終版在真實酒館中的完整驗收與長期使用體驗尚未完成；安裝成功只代表依賴與核心可用。

## 許可

本專案使用**自訂許可，不是開源許可證**，也不屬於公共領域。摘要如下（以 [LICENSE.md](LICENSE.md) 全文為準）：

- **允許**：個人為非商業學習目的下載、保存、閱讀，並依隨附說明在本地安裝、設定和執行。
- **未經權利人書面授權不得**：分發、轉載、鏡像或再發佈全部或實質部分（包括修改版與安裝包）；修改原始碼或製作衍生作品；用於任何商業用途。
- 第三方元件保留各自的許可證；GitHub 服務條款已授予的平臺內檢視與 Fork 等權利不受影響。
- 按現狀提供，不附任何擔保。

## 第三方聲明

詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。摘要：

- **OpenHer**（Apache-2.0，固定版本 `ef5b214`）：`shared/src/emotion/neural.ts` 與 `shared/src/emotion/openher.ts` 為其 TypeScript 移植與修改；許可全文見 `shared/third-party/OpenHer-LICENSE`，採用說明見 [shared/docs/OPENHER_ADOPTION.md](shared/docs/OPENHER_ADOPTION.md)。
- **AgentJev**（原始碼與模型卡均為 Apache-2.0）：推論程式的採用部分與模型權重，許可見 `shared/third-party/agentjev/`。
- **安裝時取得的依賴**：Node.js、LanceDB、TypeScript，以及 AgentJev 執行時的 Python、PyTorch（CPU）、Transformers、Safetensors 等，各自適用其許可證。

## 回報與支援

- 問題與建議請在本倉庫的 GitHub Issues 提出，附上 XLDB 版本、工作臺顯示的錯誤訊息和重現步驟。**請勿貼上 API 金鑰、私有目錄內容或聊天資料庫。**
- 連線或資料問題請先參考 [RECOVERY.md](RECOVERY.md)。
- 超出許可範圍的使用（分發、修改、商業用途）請聯絡倉庫擁有者 lty418905-blip 取得書面授權。

---

## English

*Summary only; the Chinese sections above are authoritative.*

**XLDB for SillyTavern** is a SillyTavern plugin (running in Tavern Helper) plus a local core that gives single-character and multi-NPC roleplay continuous per-character memory with knowledge boundaries, OpenHer-based per-NPC emotion, story time, world state, commitments and an optional director. Chat prose is still generated by the model you choose in SillyTavern. The companion-agent entry lives in the sibling repository [XLDB](https://github.com/lty418905-blip/XLDB); both share the `shared/` core but keep separate data.

**Status.** The last tagged release is `tavern-v0.1.3-mvp`. This `main` branch is an untagged development snapshot toward 0.2.0 and has not completed full acceptance. Memory fixes, the unified story clock (core logic present, not yet wired into the plugin) and judge routing are in progress. The optional hosted Jev judge is planned and not included.

**Install** (Windows x64, SillyTavern with Tavern Helper on the same machine, Node.js 24.x ≥ 24.18.1 or let the installer fetch a portable copy): run `START-XLDB.cmd`, import `XLDB-酒馆.json` in Tavern Helper, pair once on the opened page, then set a backend text-model API in the XLDB workbench. The local AgentJev model (about 2.4 GB) is optional and downloads in the background from the GitHub Release of the XLDB (agent) repository; without it, NPC emotion ranking uses deterministic rules. See [INSTALL_TAVERN.md](INSTALL_TAVERN.md).

**Configuration and privacy.** No keys are bundled. Backend stages send the chat, card and world text they need to your OpenAI-compatible provider (for example DeepSeek). Embedding and reranker providers (for example SiliconFlow bge-m3 and a reranker) receive queries and permitted memory text. SillyTavern's model receives the prompt XLDB assembles. AgentJev runs locally. Data is stored locally, unencrypted.

**Known limitations.** Windows only. For managed chats XLDB assembles the whole prose prompt, so SillyTavern preset prompts and author's notes are not passed through (planned for 0.3.0). Chat Completion only. No group chats. A new chat starts a new NPC. Pairing does not move with the install. Parts of the rules and UI are Chinese-only.

**Licence.** A custom licence, not open source. Personal, non-commercial study use, including local install and running, is allowed. Redistribution, modification and commercial use require written permission. Third-party parts (OpenHer and AgentJev, both Apache-2.0) keep their own licences. See [LICENSE.md](LICENSE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**Feedback.** Please use GitHub Issues and never post keys or private data.
