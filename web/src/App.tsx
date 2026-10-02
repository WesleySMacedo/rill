import { lazy, Suspense, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import AuthScreen, { type AuthMode } from "./AuthScreen";
import { supabase } from "./supabase";

const MissionWorkspace = lazy(() => import("./components/runtime/MissionWorkspace").then((module) => ({ default: module.MissionWorkspace })));
const AgentPairPage = lazy(() => import("./components/runtime/AgentPairPage").then((module) => ({ default: module.AgentPairPage })));

export default function App() {
	const [session, setSession] = useState<Session | null>(null);
	const [authReady, setAuthReady] = useState(false);
	const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
	const [pathname, setPathname] = useState(() => window.location.pathname);

	useEffect(() => {
		const onPopState = () => setPathname(window.location.pathname);
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	useEffect(() => {
		if (!supabase) {
			setAuthReady(true);
			return;
		}
		let active = true;
		const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
			setSession(nextSession);
			setAuthReady(true);
			if (event === "PASSWORD_RECOVERY") setAuthMode("update-password");
			if (event === "SIGNED_OUT") setAuthMode("sign-in");
		});
		void supabase.auth.getSession().then(({ data, error }) => {
			if (!active) return;
			setSession(error ? null : data.session);
			setAuthReady(true);
		});
		return () => {
			active = false;
			subscription.unsubscribe();
		};
	}, []);

	if (!authReady) return <main className="boot-screen"><img src="/assets/rill-logo-wh.svg" alt="Rill" /><span className="boot-indicator" /></main>;
	if (!session || authMode === "update-password") return <AuthScreen mode={authMode} setMode={setAuthMode} />;
	return <Suspense fallback={<main className="boot-screen"><img src="/assets/rill-logo-wh.svg" alt="Rill" /><span className="boot-indicator" /></main>}>{pathname === "/agent/pair" ? <AgentPairPage session={session} /> : <MissionWorkspace session={session} />}</Suspense>;
}