import { SignIn } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '../../authTheme.jsx';

export default function Page() {
  return (
    <AuthShell eyebrow="Open Generative AI" title="Welcome back" subtitle="Sign in to your studio workspace.">
      <SignIn appearance={clerkAppearance} fallbackRedirectUrl="/projects" />
    </AuthShell>
  );
}
