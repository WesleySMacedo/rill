import { useState, type FormEvent } from "react";
import {
	ArrowRight,
	ArrowUpRight,
	Check,
	Eye,
	EyeOff,
	LockKeyhole,
	ShieldCheck,
} from "lucide-react";
import { supabase, supabaseConfigured } from "./supabase";

export type AuthMode = "sign-in" | "sign-up" | "recovery" | "update-password";

export default function AuthScreen({ mode, setMode }: { mode: AuthMode; setMode: (mode: AuthMode) => void }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
	const isSignUp = mode === "sign-up";
	const isRecovery = mode === "recovery";
	const isPasswordUpdate = mode === "update-password";
	const needsPassword = !isRecovery;
	const title = isPasswordUpdate ? "Set a new password" : isRecovery ? "Reset your password" : isSignUp ? "Create your account" : "Welcome back";
	const submitLabel = isPasswordUpdate ? "Update password" : isRecovery ? "Send reset link" : isSignUp ? "Create account" : "Sign in";

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setNotice(null);
		if (!supabase) {
			setNotice({ tone: "error", text: "Supabase Auth is not configured for this deployment." });
			return;
		}
		if ((isSignUp || isPasswordUpdate) && password !== confirmPassword) {
			setNotice({ tone: "error", text: "The passwords do not match." });
			return;
		}

		setBusy(true);
		try {
			if (isRecovery) {
				const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
				if (error) throw error;
				setNotice({ tone: "success", text: "If an account matches that address, a reset link is on its way." });
			} else if (isPasswordUpdate) {
				const { error } = await supabase.auth.updateUser({ password });
				if (error) throw error;
				setPassword("");
				setConfirmPassword("");
				setMode("sign-in");
				setNotice({ tone: "success", text: "Password updated. Your authenticated session is ready." });
			} else if (isSignUp) {
				const { data, error } = await supabase.auth.signUp({
					email,
					password,
					options: { emailRedirectTo: window.location.origin },
				});
				if (error) throw error;
				if (!data.session) {
					setNotice({ tone: "success", text: "Check your inbox to confirm your email before signing in." });
				} else {
					setNotice({ tone: "success", text: "Account created. Opening your workspace…" });
				}
			} else {
				const { error } = await supabase.auth.signInWithPassword({ email, password });
				if (error) throw error;
			}
		} catch {
			setNotice({ tone: "error", text: "We could not complete that request. Check your details and try again." });
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="auth-shell">
			<section className="auth-brand-panel" aria-label="Rill identity">
				<div className="auth-brand-top">
					<div className="brand-lockup">
						<img src="/assets/rill-logo-wh.svg" alt="" className="brand-logo-small" />
						<span>RILL <i>/</i> MISSION CONTROL</span>
					</div>
					<span className="secure-label"><LockKeyhole size={13} /> PRIVATE WORKSPACE</span>
				</div>
				<div className="auth-brand-center">
					<div className="hero-logo-wrap"><img src="/assets/rill-logo-wh.svg" alt="Rill" className="hero-logo" /></div>
					<p className="eyebrow">MISSION INTELLIGENCE &amp; GOVERNANCE</p>
					<h1>Agents propose.<br /><span>Rill authorizes.</span></h1>
					<p className="auth-brand-caption">A control plane for bounded, reviewable AI work.</p>
					<div className="auth-flow" aria-label="Mission path">
						<div className="flow-node active"><span>01</span><b>INTENT</b><small>Human goal</small></div>
						<div className="flow-connector" />
						<div className="flow-node"><span>02</span><b>POLICY</b><small>Rill decides</small></div>
						<div className="flow-connector" />
						<div className="flow-node"><span>03</span><b>EVIDENCE</b><small>Traceable work</small></div>
					</div>
				</div>
				<div className="auth-brand-bottom">
					<span>CONTROL PLANE <b>●</b> HUMAN AUTHORITY</span>
					<a href="https://rill.wesleysmacedo.com" target="_blank" rel="noreferrer">rill.wesleysmacedo.com <ArrowUpRight size={12} /></a>
				</div>
			</section>
			<section className="auth-form-panel">
				<div className="auth-form-top"><span>SECURE ACCESS</span><span className="auth-top-dot"><i /> AUTH SERVICE</span></div>
				<div className="auth-form-content" key={mode}>
					<div className="auth-form-icon"><LockKeyhole size={18} strokeWidth={1.7} /></div>
					<p className="eyebrow">RILL ACCOUNT</p>
					<h2>{title}</h2>
					<p className="auth-subtitle">{isPasswordUpdate ? "Choose a strong password for your account." : isRecovery ? "We'll email you a secure password reset link." : isSignUp ? "Create an account to enter your workspace." : "Sign in to continue to your governed workspace."}</p>
					<form onSubmit={handleSubmit} className="auth-form">
						{!isPasswordUpdate && <label className="field-label" htmlFor="email">Work email<div className="input-wrap"><span className="input-icon">@</span><input id="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy} /></div></label>}
						{needsPassword && <label className="field-label" htmlFor="password">{isPasswordUpdate ? "New password" : "Password"}<div className="input-wrap"><LockKeyhole size={15} className="input-icon" /><input id="password" type={showPassword ? "text" : "password"} autoComplete={isSignUp || isPasswordUpdate ? "new-password" : "current-password"} placeholder={isPasswordUpdate ? "At least 8 characters" : "Enter your password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required disabled={busy} /><button className="input-action" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>}
						{(isSignUp || isPasswordUpdate) && <label className="field-label" htmlFor="confirm-password">Confirm password<div className="input-wrap"><LockKeyhole size={15} className="input-icon" /><input id="confirm-password" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Enter it again" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required disabled={busy} /></div></label>}
						{mode === "sign-in" && <div className="form-options"><label className="remember-option"><input type="checkbox" /> <span>Remember this device</span></label><button type="button" className="text-button" onClick={() => { setNotice(null); setMode("recovery"); }}>Forgot password?</button></div>}
						{notice && <div className={`form-notice ${notice.tone}`} role="status"><span>{notice.tone === "success" ? <Check size={15} /> : <ShieldCheck size={15} />}</span>{notice.text}</div>}
						{!supabaseConfigured && <div className="config-notice" role="status"><ShieldCheck size={15} /><span>Supabase Auth is not configured for this deployment.</span></div>}
						<button className="submit-button" type="submit" disabled={busy || !supabaseConfigured}><span>{busy ? "Please wait…" : submitLabel}</span><ArrowRight size={16} /></button>
					</form>
					<div className="auth-switch">{isSignUp ? <>Already have access? <button type="button" onClick={() => { setNotice(null); setMode("sign-in"); }}>Sign in</button></> : isRecovery || isPasswordUpdate ? <button type="button" onClick={() => { setNotice(null); setMode("sign-in"); }}>Back to sign in</button> : <>New to Rill? <button type="button" onClick={() => { setNotice(null); setMode("sign-up"); }}>Create an account <ArrowRight size={13} /></button></>}</div>
				</div>
				<div className="auth-form-footer"><span>ENCRYPTED SESSION</span><span>SUPABASE AUTH <i>●</i></span></div>
			</section>
		</main>
	);
}