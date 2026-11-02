// This process-local override is inherited by the isolated test child processes.
// It never changes the user's shell environment.
process.env.SIMULATED_TODAY = "2026-10-29";
