interface Env {
	RESEND_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const origin = context.request.headers.get('Origin') ?? '';
	const headers = {
		'Access-Control-Allow-Origin': origin,
		'Content-Type': 'application/json',
	};

	try {
		const body = (await context.request.json()) as { email?: string };
		const email = body.email?.trim().toLowerCase();

		if (!email || !email.includes('@')) {
			return new Response(JSON.stringify({ error: 'Invalid email' }), {
				status: 400,
				headers,
			});
		}

		const res = await fetch('https://api.resend.com/contacts', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${context.env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ email, unsubscribed: false }),
		});

		if (!res.ok) {
			const err = await res.text();
			console.error('Resend error:', res.status, err);
			return new Response(JSON.stringify({ error: 'Signup failed' }), {
				status: 502,
				headers,
			});
		}

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers,
		});
	} catch (e) {
		console.error('Waitlist error:', e);
		return new Response(JSON.stringify({ error: 'Server error' }), {
			status: 500,
			headers,
		});
	}
};

export const onRequestOptions: PagesFunction = async () => {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		},
	});
};
