export default function Home() {
  return (
    <main className="launch-page">
      <section className="launch-panel" aria-labelledby="home-title">
        <p className="eyebrow">Milestone 0 scaffold</p>
        <h1 id="home-title">AgentBay</h1>
        <p className="lede">
          The application shell is ready for the dashboard route that lands in the next Milestone 0
          slice.
        </p>
        <a className="primary-link" href="/dashboard">
          Open dashboard
        </a>
      </section>
    </main>
  );
}
