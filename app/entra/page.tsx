export default function Entra() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 px-4">
      <form action="/" method="GET" className="w-full max-w-xs space-y-4">
        <h1 className="text-lg font-semibold text-center">🟡 assistente oro</h1>
        <input
          type="password"
          name="passcode"
          placeholder="passcode"
          autoFocus
          className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-center outline-none focus:border-amber-500"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-amber-500 text-neutral-950 font-medium py-2 hover:bg-amber-400 transition"
        >
          entra
        </button>
      </form>
    </main>
  );
}
