//go:build android && cgo

package netcore

/*
#cgo LDFLAGS: -llog
#include <android/log.h>
#include <stdlib.h>
#include <pthread.h>
#include <stdint.h>
#include <unistd.h>
static void* wb_log_reader(void* arg) {
    int fd = (int)(intptr_t)arg;
    char buffer[4096];
    ssize_t count;
    while ((count = read(fd, buffer, sizeof(buffer)-1)) > 0) {
        buffer[count] = 0;
        __android_log_write(ANDROID_LOG_ERROR, "WorkbenchNetwork", buffer);
    }
    close(fd);
    return NULL;
}
static void wb_capture_stderr(void) {
    int fds[2];
    if (pipe(fds) != 0) return;
    if (dup2(fds[1], STDERR_FILENO) < 0) { close(fds[0]); close(fds[1]); return; }
    close(fds[1]);
    pthread_t reader;
    if (pthread_create(&reader, NULL, wb_log_reader, (void*)(intptr_t)fds[0]) == 0) pthread_detach(reader);
    else close(fds[0]);
}
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
*/
import "C"

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"tailscale.com/net/netmon"
	"unsafe"
)

// Android app UIDs cannot open NETLINK_ROUTE. Bionic's getifaddrs uses the
// supported app interface path instead, and supplies netmon with all addresses.
func init() {
	C.wb_capture_stderr()
	netmon.RegisterInterfaceGetter(androidInterfaces)
}

func androidInterfaces() ([]netmon.Interface, error) {
	var head *C.struct_ifaddrs
	result, errno := C.getifaddrs(&head)
	if result != 0 {
		return nil, fmt.Errorf("Android network interfaces: %v", errno)
	}
	defer C.freeifaddrs(head)
	interfaces := map[string]*netmon.Interface{}
	for item := head; item != nil; item = item.ifa_next {
		if item.ifa_name == nil {
			continue
		}
		name := C.GoString(item.ifa_name)
		entry := interfaces[name]
		if entry == nil {
			flags := net.Flags(0)
			value := item.ifa_flags
			if value&C.IFF_UP != 0 {
				flags |= net.FlagUp
			}
			if value&C.IFF_RUNNING != 0 {
				flags |= net.FlagRunning
			}
			if value&C.IFF_LOOPBACK != 0 {
				flags |= net.FlagLoopback
			}
			if value&C.IFF_BROADCAST != 0 {
				flags |= net.FlagBroadcast
			}
			if value&C.IFF_MULTICAST != 0 {
				flags |= net.FlagMulticast
			}
			if value&C.IFF_POINTOPOINT != 0 {
				flags |= net.FlagPointToPoint
			}
			entry = &netmon.Interface{Interface: &net.Interface{Name: name, Index: int(C.if_nametoindex(item.ifa_name)), MTU: 1500, Flags: flags}, AltAddrs: []net.Addr{}}
			interfaces[name] = entry
		}
		ip, bits := androidAddress(item.ifa_addr)
		if ip == nil {
			continue
		}
		maskIP, _ := androidAddress(item.ifa_netmask)
		mask := net.CIDRMask(bits, bits)
		if maskIP != nil && len(maskIP) == len(ip) {
			mask = net.IPMask(maskIP)
		}
		entry.AltAddrs = append(entry.AltAddrs, &net.IPNet{IP: ip, Mask: mask})
	}
	resultList := make([]netmon.Interface, 0, len(interfaces))
	for _, entry := range interfaces {
		resultList = append(resultList, *entry)
	}
	sort.Slice(resultList, func(i, j int) bool { return resultList[i].Name < resultList[j].Name })
	return resultList, nil
}
func androidAddress(address *C.struct_sockaddr) (net.IP, int) {
	if address == nil {
		return nil, 0
	}
	switch address.sa_family {
	case C.AF_INET:
		value := (*C.struct_sockaddr_in)(unsafe.Pointer(address))
		bytes := (*[4]byte)(unsafe.Pointer(&value.sin_addr))
		return net.IP(append([]byte(nil), bytes[:]...)), 32
	case C.AF_INET6:
		value := (*C.struct_sockaddr_in6)(unsafe.Pointer(address))
		bytes := (*[16]byte)(unsafe.Pointer(&value.sin6_addr))
		return net.IP(append([]byte(nil), bytes[:]...)), 128
	default:
		return nil, 0
	}
}

// The Go library cannot infer Android app-private cache paths from HOME or /tmp.
// Explicit SDK paths avoid falling back to inaccessible system directories.
func preparePlatform(dir string) error {
	for _, name := range []string{"logs", "tmp"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0700); err != nil {
			return err
		}
	}
	if err := os.Setenv("TS_LOGS_DIR", filepath.Join(dir, "logs")); err != nil {
		return err
	}
	return os.Setenv("TMPDIR", filepath.Join(dir, "tmp"))
}
