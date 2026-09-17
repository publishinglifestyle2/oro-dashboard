import { NextRequest, NextResponse } from "next/server";

// protezione leggera: se DASHBOARD_PASSCODE non è impostata, il sito resta aperto.
// impostala su vercel per non lasciare capitale e rischio visibili a chiunque trovi l'url.
export function proxy(req: NextRequest) {
  const passcode = process.env.DASHBOARD_PASSCODE;
  if (!passcode) return NextResponse.next();

  const url = new URL(req.url);
  if (req.cookies.get("oro_pass")?.value === passcode) return NextResponse.next();

  const dallaQuery = url.searchParams.get("passcode");
  if (dallaQuery === passcode) {
    const pulito = new URL(url.pathname, url);
    const res = NextResponse.redirect(pulito);
    res.cookies.set("oro_pass", passcode, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  if (url.pathname === "/entra") return NextResponse.next();
  return NextResponse.redirect(new URL("/entra", url));
}

export const config = {
  matcher: ["/((?!_next|entra|favicon.ico|api/health).*)"],
};
