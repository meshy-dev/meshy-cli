// Command meshy is the Meshy command-line interface.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/term"

	"github.com/meshy-dev/meshy-cli/internal/cmd"
)

func main() {
	// Ctrl-C and terminate signals cancel the context, which a command reports
	// as interrupted (exit 130); a second signal stops the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-ctx.Done()
		stop()
	}()
	code := cmd.Execute(ctx, cmd.Options{
		Args:             os.Args[1:],
		Stdout:           os.Stdout,
		Stderr:           os.Stderr,
		Getenv:           os.Getenv,
		StdoutIsTerminal: term.IsTerminal(int(os.Stdout.Fd())),
	})
	stop()
	os.Exit(code)
}
