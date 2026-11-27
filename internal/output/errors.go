package output

import (
	"context"
	"errors"
	"fmt"
)

// Code is the closed vocabulary of error.code. Scripts branch on it; each
// code maps to one exit code. The set and the mapping are those of the 0.x
// releases.
type Code string

// Error codes.
const (
	CodeUsage             Code = "usage"
	CodeAuth              Code = "auth"
	CodeValidation        Code = "validation"
	CodeNotFound          Code = "not_found"
	CodeRateLimit         Code = "rate_limit"
	CodeNetwork           Code = "network"
	CodeTimedOut          Code = "timed_out"
	CodeCredit            Code = "credit"
	CodeServer            Code = "server"
	CodeTaskFailed        Code = "task_failed"
	CodeSubmissionUnknown Code = "submission_unknown"
	CodeLocalIO           Code = "local_io"
	CodeCheckFailed       Code = "check_failed"
	CodeCheckUnknown      Code = "check_unknown"
	CodeConflict          Code = "conflict"
	CodeInterrupted       Code = "interrupted"
	CodeProtocol          Code = "protocol"
	CodeOperationConflict Code = "operation_conflict"
	CodeInternal          Code = "internal"
)

// Exit codes.
const (
	ExitOK                = 0
	ExitGeneric           = 1   // a task ended FAILED or CANCELED while waiting, or an unclassified error
	ExitUsage             = 2   // flag parse error, conflicting or missing arguments
	ExitAuth              = 3   // 401, no usable credential
	ExitValidation        = 4   // 400, 422, a payload rejected locally
	ExitNotFound          = 5   // 404
	ExitRateLimit         = 6   // 429
	ExitNetwork           = 7   // read failures, stream disconnects
	ExitTimedOut          = 8   // timed out waiting for or streaming a task
	ExitCredit            = 9   // 402
	ExitSubmissionUnknown = 10  // a create was sent but its outcome could not be confirmed
	ExitLocalIO           = 11  // refused overwrite, path outside --workspace, journal write failure
	ExitCheckFailed       = 12  // a local check failed
	ExitCheckUnknown      = 13  // a local check could not decide
	ExitConflict          = 14  // 409
	ExitInterrupted       = 130 // Ctrl-C or a terminate signal
)

var exitCodes = map[Code]int{
	CodeUsage:             ExitUsage,
	CodeAuth:              ExitAuth,
	CodeValidation:        ExitValidation,
	CodeNotFound:          ExitNotFound,
	CodeRateLimit:         ExitRateLimit,
	CodeNetwork:           ExitNetwork,
	CodeTimedOut:          ExitTimedOut,
	CodeCredit:            ExitCredit,
	CodeServer:            ExitGeneric,
	CodeTaskFailed:        ExitGeneric,
	CodeSubmissionUnknown: ExitSubmissionUnknown,
	CodeLocalIO:           ExitLocalIO,
	CodeCheckFailed:       ExitCheckFailed,
	CodeCheckUnknown:      ExitCheckUnknown,
	CodeConflict:          ExitConflict,
	CodeInterrupted:       ExitInterrupted,
	CodeProtocol:          ExitGeneric,
	CodeOperationConflict: ExitUsage,
	CodeInternal:          ExitGeneric,
}

// ExitCode is the process exit code for an error code; an unknown code is 1.
func ExitCode(c Code) int {
	if n, ok := exitCodes[c]; ok {
		return n
	}
	return ExitGeneric
}

// CodeForHTTPStatus classifies an API error response by its status.
func CodeForHTTPStatus(status int) Code {
	switch status {
	case 400, 422:
		return CodeValidation
	case 401:
		return CodeAuth
	case 402:
		return CodeCredit
	case 404:
		return CodeNotFound
	case 409:
		return CodeConflict
	case 429:
		return CodeRateLimit
	}
	return CodeServer
}

// Recovery says what the caller can do about a failure.
type Recovery struct {
	// Action is what to do: reconcile, retry, wait, login, top_up, …
	Action string `json:"action"`
	// Automatic is whether the CLI already did it.
	Automatic bool `json:"automatic"`
	// Command can be run verbatim to recover, when one is known.
	Command string `json:"command,omitempty"`
}

// Error is a failure with everything the error envelope carries. Commands
// return it (or wrap it); anything else is classified by Classify.
type Error struct {
	Code    Code
	Message string
	// HTTPStatus is the API response status, or 0 when no response was read.
	HTTPStatus int
	Retryable  bool
	Recovery   *Recovery
	// Hint is a command or sentence that fixes the failure, when one is known.
	Hint string
	// Details is machine-readable context, such as the API's error body.
	Details any
	// Result is the partial state that must survive the failure (a task id
	// after a later step failed, files already written). It becomes the
	// envelope's result.
	Result   any
	Warnings []Warning
	// Err is the underlying cause.
	Err error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

// ExitCode is the process exit code for this error.
func (e *Error) ExitCode() int { return ExitCode(e.Code) }

// Errorf returns an *Error with the given code and message.
func Errorf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Classify turns any error into an *Error: an *Error anywhere in the chain is
// used as is, a canceled context is an interruption, anything else is
// internal.
func Classify(err error) *Error {
	if e, ok := errors.AsType[*Error](err); ok {
		return e
	}
	if errors.Is(err, context.Canceled) {
		return &Error{Code: CodeInterrupted, Message: "interrupted", Err: err}
	}
	return &Error{Code: CodeInternal, Message: err.Error(), Err: err}
}
