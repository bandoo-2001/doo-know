/* Keep guarded workloads and their descendants in the registered process group.
 * This is a lifecycle boundary for trusted tools, not an arbitrary-code sandbox.
 * The bootstrap registers this PID before exec; both execs retain its identity.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "The native process runner currently requires Linux x86_64"
#endif

static int refuse(const char *message, int code) {
  size_t left = strlen(message);
  while (left) {
    ssize_t count = write(STDERR_FILENO, message, left);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    message += count;
    left -= (size_t)count;
  }
  return code;
}

int main(int argc, char **argv) {
  const int check = argc == 2 && strcmp(argv[1], "--check") == 0;
  if (!check && (argc < 3 || strcmp(argv[1], "--") != 0))
    return refuse("PROCESS_START_FAILED\n", 127);
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* The x32 ABI shares the arch value but has different syscall numbers. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setsid, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setpgid, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
  };
  struct sock_fprog program = {sizeof(rules) / sizeof(rules[0]), rules};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0UL, 0UL))
    return refuse("PROCESS_CONTAINMENT_UNAVAILABLE\n", 126);
  if (check) {
    errno = 0;
    if (syscall(SYS_setpgid, 0, 0) != -1 || errno != EPERM)
      return refuse("PROCESS_CONTAINMENT_UNAVAILABLE\n", 126);
    errno = 0;
    if (syscall(SYS_setsid) != -1 || errno != EPERM)
      return refuse("PROCESS_CONTAINMENT_UNAVAILABLE\n", 126);
    return 0;
  }
  execv(argv[2], argv + 2);
  return refuse("PROCESS_START_FAILED\n", 127);
}
