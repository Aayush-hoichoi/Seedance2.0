import LedgerClient from './LedgerClient.jsx';
import RecoveryPanel from './RecoveryPanel.jsx';
import { isAdmin } from '../../../lib/auth/user.js';

export const metadata = { title: 'Ledger — loglineAI Studio' };

export default async function LedgerPage() {
    const admin = await isAdmin();
    return <div className="space-y-5">{admin && <RecoveryPanel />}<LedgerClient /></div>;
}
