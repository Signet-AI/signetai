interface Env {
	GHL_API_KEY: string;
	GHL_LOCATION_ID: string;
	RATE_LIMITER: RateLimit;
}

const ALLOWED_ORIGINS = ["https://signetai.sh", "https://www.signetai.sh"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(origin: string): Record<string, string> {
	if (!origin) return {};
	if (ALLOWED_ORIGINS.includes(origin)) return { "Access-Control-Allow-Origin": origin };
	// Allow localhost and Tailscale origins for local dev
	if (origin.startsWith("http://localhost:") || origin.startsWith("http://100.")) {
		return { "Access-Control-Allow-Origin": origin };
	}
	return {};
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const origin = context.request.headers.get("Origin") ?? "";
	const headers = {
		...corsHeaders(origin),
		"Content-Type": "application/json",
	};

	// Rate limit by IP — 10 submissions per 60 seconds
	if (context.env.RATE_LIMITER) {
		const ip = context.request.headers.get("CF-Connecting-IP") ?? "unknown";
		const { success } = await context.env.RATE_LIMITER.limit({ key: ip });
		if (!success) {
			return new Response(JSON.stringify({ error: "Too many requests" }), {
				status: 429,
				headers,
			});
		}
	}

	try {
		const body = (await context.request.json()) as {
			firstName?: string;
			lastName?: string;
			phone?: string;
			email?: string;
			optin?: boolean;
		};

		const firstName = (body.firstName?.trim() ?? "").slice(0, 50);
		const lastName = (body.lastName?.trim() ?? "").slice(0, 50);
		const phone = (body.phone?.trim() ?? "").slice(0, 20);
		const email = (body.email?.trim().toLowerCase() ?? "").slice(0, 254);
		const optin = body.optin === true;

		if (!firstName || !lastName) {
			return new Response(JSON.stringify({ error: "First name and last name required" }), {
				status: 400,
				headers,
			});
		}

		if (email && !EMAIL_RE.test(email)) {
			return new Response(JSON.stringify({ error: "Invalid email address" }), {
				status: 400,
				headers,
			});
		}

		const phoneDigits = phone.replace(/\D/g, "");
		if (phoneDigits && phoneDigits.length !== 10) {
			return new Response(JSON.stringify({ error: "Phone must be a 10-digit US number" }), {
				status: 400,
				headers,
			});
		}

		// Create/update contact in GoHighLevel (v2 API)
		if (!context.env.GHL_API_KEY || !context.env.GHL_LOCATION_ID) {
			console.error("Missing GHL_API_KEY or GHL_LOCATION_ID");
			return new Response(JSON.stringify({ error: "Server misconfigured", detail: "Missing GHL credentials" }), {
				status: 500,
				headers,
			});
		}

		const ghlRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${context.env.GHL_API_KEY}`,
				"Content-Type": "application/json",
				Version: "2021-07-28",
			},
			body: JSON.stringify({
				locationId: context.env.GHL_LOCATION_ID,
				firstName,
				lastName,
				...(email ? { email } : {}),
				...(phoneDigits ? { phone: `+1${phoneDigits}` } : {}),
				tags: ["signet new lead"],
				source: "signetai.sh",
				customFields: [{ key: "newsletter_optin", field_value: optin ? "yes" : "no" }],
			}),
		});

		if (!ghlRes.ok) {
			const err = await ghlRes.text();
			console.error("GHL error:", ghlRes.status, err);
			return new Response(JSON.stringify({ error: "Signup failed", detail: err }), { status: 502, headers });
		}

		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	} catch (e) {
		console.error("Optin error:", e);
		return new Response(JSON.stringify({ error: "Server error" }), {
			status: 500,
			headers,
		});
	}
};

export const onRequestOptions: PagesFunction = async (context) => {
	const origin = context.request.headers.get("Origin") ?? "";
	return new Response(null, {
		status: 204,
		headers: {
			...corsHeaders(origin),
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
};
