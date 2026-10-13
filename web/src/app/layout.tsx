import type { Metadata, Viewport } from "next";
import { dmSans, heebo, readexPro, bellefair, notoNaskh } from "@/lib/fonts";
import { AppShell } from "@/components/app-shell";
import { AuthSession } from "@/components/auth-session";
import { auth } from "@/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "jobby — AI job search command center",
  description: "Your AI-powered, local-first job search pipeline.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "jobby" },
  icons: {
    icon: "/icon.svg",
    apple: "/brand/jobby-wordmark.png",
  },
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#090A0F",
};

// Before paint: theme class + theme-color meta. Light #F8F8F6 / dark #090A0F.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('jobby:theme')||localStorage.getItem('career-ops:theme');if(t)localStorage.setItem('jobby:theme',t);var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.setAttribute('name','theme-color');document.head.appendChild(m);}m.setAttribute('content',d?'#090A0F':'#F8F8F6');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const signedIn = !!session?.user;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-tenant={session?.tenantId ?? ""}
      className={`${dmSans.variable} ${heebo.variable} ${readexPro.variable} ${bellefair.variable} ${notoNaskh.variable}`}
    >
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <AuthSession>
          {signedIn ? <AppShell>{children}</AppShell> : children}
        </AuthSession>
      </body>
    </html>
  );
}
