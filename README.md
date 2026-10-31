# osd-predict

**Nansen のスマートマネーと OSD の判定を x402 で買って予測する。**

決算前にスマートマネーが集めていた株式トークンは、決算で条件を満たしたか。
Solana 上の株式トークン（xStocks・Ondo）に流れ込んだスマートマネーのフローを Nansen から、
決算イベントの条件と判定の履歴を [Onchain Stock Data（OSD）](https://osd.x402jp.com) から、
どちらも x402 の per-call（USDC on Solana）で買う。判定待ちの条件ごとに「当たる確率」を締切の前に出し、
その日の記録の SHA-256 を Solana の memo に書いて封印し、OSD で判定が確定したら採点する。

Flow data: [Powered by Nansen API](https://nansen.ai) ・ Conditions and verdicts: OSD ・ 投資助言ではない。

## 3つの予測

| predictor | 中身 | 公開 |
| --- | --- | --- |
| `base-rate-v1`（系統A） | OSD の記録だけから出す基準率。全体 → 母集団 → 母集団×条件の種類 → 銘柄、と縮小推定で寄せる。判定日が会社の公表日と未照合なら 0.5 に寄せる。 | 個別の予測を公開 |
| `base-rate+nansen-v1`（系統N） | 系統A を、締切前のスマートマネーの状態（流入・流出・なし）で補正する。補正量は ±0.05 から始め、判定が20件たまったら実績で推定し直す（`data/adjustments.json`）。 | **採点の集計値だけ**（下記） |
| `claude-fable-5-1 (chat)`（系統B） | 週1回、チャットで出した確率を取り込む（出典 URL 必須）。 | 個別の予測を公開 |

採点は hit = 1・partial = 0.5・miss = 0（na・excluded は採点しない）。締切前の最後の予測で、
Brier スコア、確率帯ごとの較正、フローの状態ごとの的中率を出し、「常に 0.5」と系統A を基準に比べる。
見る点は、**系統N が系統A より良いか**（スマートマネーのフローが決算の条件に情報を足しているか）。

言語モデルの API は呼ばない。売買の執行も、売買を勧める表示もしない。

## Nansen のデータの扱い

Nansen の [Data Redistribution Guidelines](https://docs.nansen.ai/guides/redistribution-guide) に従う。

- **Smart Money Netflows**（`smart-money/netflow`）は Restricted。承認が出るまでは**内部の分析にだけ**使う。
  取得結果と系統N の予測（basis にフローの値を含む）は `private/` に **AES-256-GCM で暗号化して**置き、
  公開するのは系統N の採点の集計値（Brier スコア、状態別の的中率）だけ。承認は申請中。
- **Flow Intelligence**（`tgm/flow-intelligence`）は表示つきで再配布できる。`data/flows-public/` に平文で置き、
  `/api/flows/{ticker}` で "Powered by Nansen API" を付けて出す。
- 「誰が何を買ったか」を配る API（スマートマネーの状態をそのまま返すもの）は作らない。

## OSD を買う部分について

OSD の条件と判定は OSD の公開リポジトリにすべてあり、判定待ちの一覧もそこから無料で取っている。
`/api/solana-stocks/{ticker}?view=full` を x402 で買うのは、**x402 で決済する経路を実際に動かし続けるため**で、
情報を得るためではない。また、**自社のエージェントが自社の OSD を買う部分は外部需要の観測ではない。**

## 1日の流れ（GitHub Actions、毎日 07:00 JST）

1. OSD の公開リポジトリから条件と判定を取り、前日と比べる
2. Nansen：Smart Money Netflows を全 mint まとめて1回（内部用）、Flow Intelligence を mint ごとに1回（公開用）
3. OSD：新しい条件・判定の確定・最終購入から7日以上、のどれかに当たる銘柄だけ `?view=full` を買う
4. 予測：系統A（全件）、系統N（Solana にトークンがあり、フローを買えた銘柄）。前回から変わったものだけ追記
5. 記録：`data/predictions/`・`data/flows-public/`・`private/flows/`・`private/predictions-n/`（すべて追記のみ）
6. 封印：その日のファイルの SHA-256（非公開のものは平文のハッシュ）を Solana の memo に書き、`data/seals/` に tx を残す
7. 採点：`data/scores/latest.json`

## 支払いの上限（`config/limits.json`）

| 相手 | 1回の上限 | 受取先 |
| --- | --- | --- |
| Nansen Smart Money Netflows | 0.05 USDC | `J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx`（2026-10-30 の 402 で確認） |
| Nansen Flow Intelligence | 0.01 USDC | 同上 |
| OSD `?view=full` | 0.005 USDC（402 の実額 0.001 の5倍） | `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf` |
| 1日の合計 | 1.00 USDC | — |

402 の金額が上限を超える、受取先が違う、Solana・USDC 以外、1日の合計を超える、同じものを同じ日に買う
——のどれでも、署名せずに `data/purchases/` に理由を残す。

## API

| | 価格 | 中身 |
| --- | --- | --- |
| `GET /api/predictions/latest` | 無料 | 直近の予測（系統A・B）と採点 |
| `GET /api/predictions/{id}` | 無料 | その条件の予測の履歴・basis・封印の tx |
| `GET /api/flows/{ticker}` | 0.01 USDC | Flow Intelligence と、OSD の次の決算条件・締切 |

## チャット（系統B）

```
npm run export:chat                       # .local/chat-input/YYYY-MM-DD.md（内部用・コミットしない）
npm run import:chat -- predictions.json   # data/predictions/ に追記（次の日次実行で封印）
```

形式：`{"type":"predictions","items":[{"id","p_hit","reasoning","sources":[URL],"predicted_at","predictor":"claude-fable-5-1 (chat)"}]}`

## セットアップ

`scripts/setup-secrets.sh` を手元で1回実行すると、予測用のウォレットと非公開データの鍵を手元で作り、
Actions の secret（`SOLANA_SECRET_KEY`・`PRIVATE_DATA_KEY`）に登録する。表示されるアドレスに USDC と少額の SOL を入れる。
公開 API は Vercel（`PAYAI_API_KEY_ID`・`PAYAI_API_KEY_SECRET`、任意で `SOLANA_RECEIVE_ADDRESS`・`PUBLIC_BASE_URL`）。
