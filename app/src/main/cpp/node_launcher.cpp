#include <node.h>
#include <climits>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#ifdef __ANDROID__
#include <csignal>
#include <sys/prctl.h>
#include <unistd.h>
#endif

int main(int argc, char** argv) {
#ifdef __ANDROID__
    // Optional prefix --host-parent-pid <pid> is used by the Java bot-host
    // supervisor. Die with SIGKILL when the parent dies and verify getppid
    // afterwards to close the race between fork and PR_SET_PDEATHSIG.
    if (argc >= 3 && std::strcmp(argv[1], "--host-parent-pid") == 0) {
        errno = 0;
        char* end = nullptr;
        long pid = std::strtol(argv[2], &end, 10);
        if ((errno == ERANGE && (pid == LONG_MAX || pid == LONG_MIN)) ||
            end == argv[2] || *end != '\0' || pid <= 0 || pid > INT_MAX) {
            return 64; // exit code 64: invalid --host-parent-pid value
        }
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 65; // prctl failed
        if (getppid() != static_cast<pid_t>(pid)) return 66; // parent changed/not matching
        for (int i = 3; i < argc; ++i) argv[i - 2] = argv[i];
        argc -= 2;
        argv[argc] = nullptr;
    }
#endif
    return node::Start(argc, argv);
}
