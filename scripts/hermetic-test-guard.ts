import { afterEach } from "bun:test";

afterEach(() => {
	const leaked = Object.keys(process.env).filter((key) => process.env[key] === "undefined");
	if (leaked.length === 0) return;
	for (const key of leaked) delete process.env[key];
	throw new Error(
		`Test left ${leaked.join(", ")} set to the string "undefined"; delete the variable instead of assigning undefined`,
	);
});
