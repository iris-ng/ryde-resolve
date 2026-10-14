import '../lab/lab.css';
import '../lab/ryde.css';

// Target of the notice's appeal link. Appeals are not built in this prototype; the page says so
// instead of a 404, and records nothing.
export default async function AppealPage({ searchParams }: { searchParams: Promise<{ case?: string; party?: string }> }) {
  const { case: caseId, party } = await searchParams;
  const who = party === 'driver' ? 'driver' : party === 'rider' ? 'rider' : null;
  return <main className="lab-appeal">
    <h1>Ask for a review</h1>
    <p>{caseId ? `Case ${caseId}` : 'No case given'}{who ? `, as the ${who}` : ''}.</p>
    <p>This prototype does not send review requests yet. In production this page would open a RydeHELP review of the decision, within 30 days, with your reasons and any new evidence.</p>
    <p>Nothing was recorded. <a href="/">Back to the lab</a></p>
  </main>;
}
