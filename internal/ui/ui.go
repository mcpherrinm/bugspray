package ui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed files
var files embed.FS

func Assets() http.Handler {
	sub, err := fs.Sub(files, "files")
	if err != nil {
		panic(err)
	}
	return http.FileServerFS(sub)
}
