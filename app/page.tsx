export default function Home() {
  return (
    <main>
      <h1>osd-predict</h1>
      <p>
        Nansen のスマートマネーと OSD の判定を x402 で買って、決算の条件ごとに当たる確率を締切前に出し、
        Solana に封印して、判定後に採点する。
      </p>
      <ul>
        <li><code>GET /api/predictions/latest</code> — 無料。直近の予測と採点</li>
        <li><code>GET /api/predictions/{"{id}"}</code> — 無料。その条件の予測の履歴と封印の tx</li>
        <li><code>GET /api/flows/{"{ticker}"}</code> — 0.01 USDC（x402・Solana）。Flow Intelligence と OSD の次の条件</li>
      </ul>
      <p>
        Flow data: <a href="https://nansen.ai">Powered by Nansen API</a>. Conditions and verdicts:{" "}
        <a href="https://osd.x402jp.com">Onchain Stock Data</a>. 投資助言ではありません。
      </p>
    </main>
  );
}
