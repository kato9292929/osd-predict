export const metadata = {
  title: "osd-predict",
  description: "Nansen smart money flows × OSD earnings conditions — dated predictions, sealed on Solana, scored after the fact.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "2rem auto", padding: "0 1rem", lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}
