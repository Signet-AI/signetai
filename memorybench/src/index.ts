import { cli } from "./cli"

const args = process.argv.slice(2)
cli(args).catch(console.error)
