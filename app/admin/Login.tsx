import { login } from "./actions";

export default function Login({ error }: { error?: string }) {
  return (
    <main className="hero-bg flex min-h-dvh items-center justify-center px-4 text-white">
      <form action={login} className="w-full max-w-sm rounded-3xl bg-white/10 p-6 ring-1 ring-white/15">
        <h1 className="font-heading text-2xl font-bold">Admin login</h1>
        <label htmlFor="password" className="mt-4 block text-sm text-white/75">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          className="mt-1 h-12 w-full rounded-xl bg-white px-4 text-navy outline-none focus:ring-2 focus:ring-orange"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-orange">
            {error === "wait" ? "Too many attempts. Try again in 15 minutes." : "Wrong password."}
          </p>
        )}
        <button className="mt-4 h-12 w-full rounded-xl bg-orange font-heading text-lg font-bold">Log in</button>
      </form>
    </main>
  );
}
