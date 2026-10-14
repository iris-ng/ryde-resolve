import Review from './review';
import '../lab/lab.css';
import '../lab/ryde.css';
import '../lab/gates.css';
import './precedents.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Past rulings · Ryde Resolve' };
// Reviewer-drafted past rulings (the learning loop): approve, edit, reject or withdraw. Same operator session as the lab.
export default function PrecedentsPage() { return <Review />; }
