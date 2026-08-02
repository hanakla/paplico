import * as Sentry from "@sentry/nextjs";

Sentry.init({
	dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
	enabled: process.env.NODE_ENV === "production",
	tracesSampleRate: 0.1,
	beforeSend(event) {
		if (event.request?.url) {
			event.request.url = event.request.url
				.replace(/(\?)token=[^&]*&?|&token=[^&]*/g, "$1")
				.replace(/(\?)state=[^&]*&?|&state=[^&]*/g, "$1");
		}
		if (event.request?.query_string) {
			const qs = event.request.query_string;
			if (typeof qs === "string") {
				event.request.query_string = qs
					.replace(/token=[^&]*/g, "token=***")
					.replace(/state=[^&]*/g, "state=***");
			} else if (Array.isArray(qs)) {
				event.request.query_string = qs.filter(
					([k]) => k !== "token" && k !== "state",
				);
			} else {
				const { token: _t, state: _s, ...rest } = qs;
				event.request.query_string = rest;
			}
		}
		return event;
	},
});
