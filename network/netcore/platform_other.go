//go:build !android || !cgo

package netcore

func preparePlatform(string) error { return nil }
