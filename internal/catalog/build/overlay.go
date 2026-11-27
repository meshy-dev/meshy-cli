package build

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/meshy-dev/meshy-cli/internal/catalog"
)

// overlay is overlay/cli.yaml: what the CLI adds to the spec by hand. It may
// name operations and fields, never restate a type, an enum, a required flag
// or a limit; those come only from the spec.
type overlay struct {
	// CLIFlags are flags the CLI itself defines. A generated parameter may
	// not take the same name on any command a flag applies to.
	CLIFlags []cliFlag `yaml:"cli_flags"`
	// Commands are the paths of hand-written commands ("schema",
	// "tasks wait"). A generated command may not take one.
	Commands []string `yaml:"commands"`
	// Operations add to generated commands, keyed by operationId.
	Operations map[string]operationOverlay `yaml:"operations"`
}

type cliFlag struct {
	Name string `yaml:"name"`
	// On limits the flag to commands whose dotted name matches one of these
	// path.Match patterns ("*.create"); empty means every command.
	On []string `yaml:"on"`
}

type operationOverlay struct {
	// Exclusive lists groups of wire names of which a request may send at
	// most one.
	Exclusive [][]string `yaml:"exclusive"`
}

func parseOverlay(b []byte) (*overlay, error) {
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	var o overlay
	if err := dec.Decode(&o); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("overlay/cli.yaml: %w", err)
	}
	return &o, nil
}

func (f cliFlag) appliesTo(name string) bool {
	if len(f.On) == 0 {
		return true
	}
	for _, pat := range f.On {
		if ok, _ := path.Match(pat, name); ok {
			return true
		}
	}
	return false
}

// applyOverlay checks the overlay against the generated commands and adds
// what it carries to them.
func applyOverlay(o *overlay, cmds []catalog.Command) []string {
	var problems []string
	byID := map[string]*catalog.Command{}
	byName := map[string]bool{}
	for i := range cmds {
		byID[cmds[i].OperationID] = &cmds[i]
		byName[cmds[i].Name()] = true
	}

	seenFlag := map[string]bool{}
	for _, f := range o.CLIFlags {
		if !flagName.MatchString(f.Name) {
			problems = append(problems, fmt.Sprintf("overlay cli_flags: %q is not a kebab-case flag name", f.Name))
		}
		if seenFlag[f.Name] {
			problems = append(problems, fmt.Sprintf("overlay cli_flags: %s is listed twice", f.Name))
		}
		seenFlag[f.Name] = true
		for _, pat := range f.On {
			if _, err := path.Match(pat, ""); err != nil {
				problems = append(problems, fmt.Sprintf("overlay cli_flags: %s: bad pattern %q", f.Name, pat))
			}
		}
		for i := range cmds {
			c := &cmds[i]
			if !f.appliesTo(c.Name()) {
				continue
			}
			for _, p := range c.Params {
				if p.Name == f.Name {
					problems = append(problems, fmt.Sprintf("%s: generated flag --%s (%s %s) has the name of the CLI's own --%s", c.Name(), p.Name, p.In, p.Field, f.Name))
				}
			}
		}
	}

	seenCmd := map[string]bool{}
	for _, hw := range o.Commands {
		words := strings.Fields(hw)
		name := strings.Join(words, ".")
		if len(words) == 0 {
			problems = append(problems, "overlay commands: empty command path")
			continue
		}
		if seenCmd[name] {
			problems = append(problems, fmt.Sprintf("overlay commands: %q is listed twice", hw))
		}
		seenCmd[name] = true
		if byName[name] {
			problems = append(problems, fmt.Sprintf("hand-written command %q has the path of a generated command", hw))
		}
	}

	for _, id := range sortedKeys(o.Operations) {
		c := byID[id]
		if c == nil {
			problems = append(problems, fmt.Sprintf("overlay operations: %s is not an operation of the spec", id))
			continue
		}
		for _, group := range o.Operations[id].Exclusive {
			if len(group) < 2 {
				problems = append(problems, fmt.Sprintf("overlay %s: an exclusive group needs two or more fields, got %v", id, group))
				continue
			}
			ok := true
			for i, field := range group {
				if c.Param(field) == nil {
					problems = append(problems, fmt.Sprintf("overlay %s: exclusive field %s is not a parameter of %s", id, field, c.Name()))
					ok = false
				}
				if slices.Contains(group[:i], field) {
					problems = append(problems, fmt.Sprintf("overlay %s: exclusive group %v names %s twice", id, group, field))
					ok = false
				}
			}
			if ok {
				c.Exclusive = append(c.Exclusive, slices.Clone(group))
			}
		}
	}
	return problems
}

// Reserved returns what an overlay reserves for the CLI's own use: the flags
// it puts on every command and the paths of its hand-written commands (words
// joined by spaces). Tests use it to keep the overlay in step with the
// command tree.
func Reserved(b []byte) (globalFlags, commands []string, err error) {
	o, err := parseOverlay(b)
	if err != nil {
		return nil, nil, err
	}
	for _, f := range o.CLIFlags {
		if len(f.On) == 0 {
			globalFlags = append(globalFlags, f.Name)
		}
	}
	for _, c := range o.Commands {
		commands = append(commands, strings.Join(strings.Fields(c), " "))
	}
	return globalFlags, commands, nil
}
