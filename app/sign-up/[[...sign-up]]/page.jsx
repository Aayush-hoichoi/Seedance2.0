import { SignUp } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '../../authTheme.jsx';

export default function Page() {
  return (
    <AuthShell eyebrow="Open Generative AI" title="Create your account" subtitle="Start generating in a shared studio workspace.">
      <SignUp appearance={clerkAppearance} />
    </AuthShell>
  );
}
