package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// writePretty prints a generic indented view of v for a person: "key: value"
// lines, "- " list items, "-" for null. Keys keep the order v encodes them in.
// It is a view, not a contract: it may drop or reshape fields.
func writePretty(w io.Writer, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	node, err := decodeOrdered(dec)
	if err != nil {
		return err
	}
	var b strings.Builder
	renderPretty(&b, node, 0)
	b.WriteByte('\n')
	_, err = io.WriteString(w, b.String())
	return err
}

type member struct {
	key   string
	value any
}

// object keeps the members of a JSON object in document order.
type object []member

func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			list := []any{}
			for dec.More() {
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := dec.Token() // ]
			return list, err
		}
		obj := object{}
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			v, err := decodeOrdered(dec)
			if err != nil {
				return nil, err
			}
			obj = append(obj, member{keyTok.(string), v})
		}
		_, err := dec.Token() // }
		return obj, err
	default:
		return t, nil
	}
}

func renderPretty(b *strings.Builder, v any, indent int) {
	pad := strings.Repeat("  ", indent)
	switch t := v.(type) {
	case nil:
		b.WriteString(pad + "-")
	case []any:
		if len(t) == 0 {
			b.WriteString(pad + "[]")
			return
		}
		for i, item := range t {
			if i > 0 {
				b.WriteByte('\n')
			}
			var sub strings.Builder
			renderPretty(&sub, item, indent+1)
			b.WriteString(pad + "- " + strings.TrimLeft(sub.String(), " "))
		}
	case object:
		if len(t) == 0 {
			b.WriteString(pad + "{}")
			return
		}
		for i, m := range t {
			if i > 0 {
				b.WriteByte('\n')
			}
			if isEmptyContainer(m.value) || !isContainer(m.value) {
				var sub strings.Builder
				renderPretty(&sub, m.value, 0)
				b.WriteString(pad + m.key + ": " + sub.String())
				continue
			}
			b.WriteString(pad + m.key + ":\n")
			renderPretty(b, m.value, indent+1)
		}
	default:
		b.WriteString(pad + fmt.Sprint(t))
	}
}

func isContainer(v any) bool {
	switch v.(type) {
	case []any, object:
		return true
	}
	return false
}

func isEmptyContainer(v any) bool {
	switch t := v.(type) {
	case []any:
		return len(t) == 0
	case object:
		return len(t) == 0
	}
	return false
}
