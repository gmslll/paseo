#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_NOFOLLOW
#error "Darwin workspace filesystem requires O_NOFOLLOW"
#endif

#ifndef O_CLOEXEC
#error "Darwin workspace filesystem requires O_CLOEXEC"
#endif

#ifndef WORKSPACE_ABI_VERSION
#define WORKSPACE_ABI_VERSION 1
#endif

static const char *errno_code(int value) {
  switch (value) {
  case EACCES:
    return "EACCES";
  case EBADF:
    return "EBADF";
  case EEXIST:
    return "EEXIST";
  case EINVAL:
    return "EINVAL";
  case EIO:
    return "EIO";
  case EISDIR:
    return "EISDIR";
  case ELOOP:
    return "ELOOP";
  case ENAMETOOLONG:
    return "ENAMETOOLONG";
  case ENOENT:
    return "ENOENT";
  case ENOTDIR:
    return "ENOTDIR";
  case ENOTEMPTY:
    return "ENOTEMPTY";
  case EPERM:
    return "EPERM";
  case EXDEV:
    return "EXDEV";
  default:
    return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, int value, const char *operation) {
  char message[256];
  snprintf(message, sizeof(message), "%s failed: %s", operation,
           strerror(value));
  napi_throw_error(env, errno_code(value), message);
  return NULL;
}

static bool get_bounded_int32(napi_env env, napi_value value, int32_t minimum,
                              int32_t maximum, const char *subject,
                              int32_t *output) {
  napi_valuetype value_type;
  double number;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < (double)minimum ||
      number > (double)maximum || number != (double)(int32_t)number) {
    char message[128];
    snprintf(message, sizeof(message), "%s must be an integer from %d to %d",
             subject, minimum, maximum);
    napi_throw_type_error(env, "EINVAL", message);
    return false;
  }
  *output = (int32_t)number;
  return true;
}

static bool get_boolean(napi_env env, napi_value value, const char *subject,
                        bool *output) {
  napi_valuetype value_type;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_boolean ||
      napi_get_value_bool(env, value, output) != napi_ok) {
    char message[96];
    snprintf(message, sizeof(message), "%s must be a boolean", subject);
    napi_throw_type_error(env, "EINVAL", message);
    return false;
  }
  return true;
}

static bool get_entry_name(napi_env env, napi_value value,
                           char output[NAME_MAX + 1]) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > NAME_MAX) {
    napi_throw_type_error(env, "EINVAL", "invalid directory entry name");
    return false;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, output, NAME_MAX + 1, &copied) !=
          napi_ok ||
      copied != length || strlen(output) != length ||
      strchr(output, '/') != NULL || strcmp(output, ".") == 0 ||
      strcmp(output, "..") == 0) {
    napi_throw_type_error(env, "EINVAL", "invalid directory entry name");
    return false;
  }
  return true;
}

static bool get_absolute_path(napi_env env, napi_value value,
                              char output[PATH_MAX]) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length >= PATH_MAX) {
    napi_throw_type_error(env, "EINVAL", "invalid absolute workspace root");
    return false;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, output, PATH_MAX, &copied) !=
          napi_ok ||
      copied != length || strlen(output) != length || output[0] != '/') {
    napi_throw_type_error(env, "EINVAL", "invalid absolute workspace root");
    return false;
  }
  return true;
}

static napi_value descriptor_value(napi_env env, int descriptor) {
  napi_value output;
  if (napi_create_int32(env, descriptor, &output) != napi_ok) {
    int saved_errno = errno;
    close(descriptor);
    if (saved_errno == 0)
      saved_errno = EIO;
    return throw_errno(env, saved_errno, "return descriptor");
  }
  return output;
}

static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  char absolute_path[PATH_MAX];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || !get_absolute_path(env, argv[0], absolute_path)) {
    if (argc != 1)
      napi_throw_type_error(env, "EINVAL", "openRoot requires one path");
    return NULL;
  }

  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0)
    return throw_errno(env, errno, "open root anchor");
  char *cursor = absolute_path + 1;
  while (*cursor != '\0') {
    char *separator = strchr(cursor, '/');
    if (separator != NULL)
      *separator = '\0';
    size_t length = strlen(cursor);
    if (length == 0 || length > NAME_MAX || strcmp(cursor, ".") == 0 ||
        strcmp(cursor, "..") == 0) {
      close(current);
      napi_throw_type_error(env, "EINVAL", "invalid absolute workspace root");
      return NULL;
    }
    int next = openat(current, cursor,
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      int saved_errno = errno;
      close(current);
      return throw_errno(env, saved_errno, "open workspace root component");
    }
    if (close(current) != 0) {
      int saved_errno = errno;
      close(next);
      return throw_errno(env, saved_errno, "close workspace root component");
    }
    current = next;
    if (separator == NULL)
      break;
    cursor = separator + 1;
  }
  return descriptor_value(env, current);
}

static bool get_open_flags(napi_env env, napi_value value, int32_t *output) {
  if (!get_bounded_int32(env, value, 0, INT32_MAX, "flags", output))
    return false;
  const int32_t allowed =
      O_ACCMODE | O_CREAT | O_EXCL | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC |
      O_NONBLOCK;
  const int32_t access = *output & O_ACCMODE;
  if ((*output & ~allowed) != 0 ||
      (access != O_RDONLY && access != O_RDWR) ||
      ((*output & O_EXCL) != 0 && (*output & O_CREAT) == 0) ||
      ((*output & O_DIRECTORY) != 0 &&
       ((*output & O_CREAT) != 0 || access != O_RDONLY)) ||
      ((*output & O_CREAT) != 0 &&
       (access != O_RDWR || (*output & O_EXCL) == 0)) ||
      ((*output & O_CREAT) == 0 && access != O_RDONLY)) {
    napi_throw_type_error(env, "EINVAL", "invalid workspace open flags");
    return false;
  }
  return true;
}

static bool get_open_mode(napi_env env, napi_value value, int32_t flags,
                          int32_t *output) {
  if (!get_bounded_int32(env, value, 0, 07777, "mode", output))
    return false;
  if (((flags & O_CREAT) != 0 && *output != 0600) ||
      ((flags & O_CREAT) == 0 && *output != 0)) {
    napi_throw_type_error(env, "EINVAL", "invalid workspace open mode");
    return false;
  }
  return true;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int32_t dirfd = -1;
  int32_t flags = 0;
  int32_t mode = 0;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 4) {
    napi_throw_type_error(env, "EINVAL",
                          "openAt requires dirfd, name, flags, and mode");
    return NULL;
  }
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name) ||
      !get_open_flags(env, argv[2], &flags) ||
      !get_open_mode(env, argv[3], flags, &mode))
    return NULL;
  flags |= O_NOFOLLOW | O_CLOEXEC;
  int descriptor = openat(dirfd, name, flags, (mode_t)mode);
  if (descriptor < 0)
    return throw_errno(env, errno, "openat");
  return descriptor_value(env, descriptor);
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t dirfd = -1;
  int32_t mode = 0;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 3) {
    napi_throw_type_error(env, "EINVAL", "mkdirAt requires dirfd, name, and mode");
    return NULL;
  }
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name) ||
      !get_bounded_int32(env, argv[2], 0, 07777, "mode", &mode))
    return NULL;
  if (mode != 0700) {
    napi_throw_type_error(env, "EINVAL", "invalid workspace directory mode");
    return NULL;
  }
  if (mkdirat(dirfd, name, (mode_t)mode) != 0)
    return throw_errno(env, errno, "mkdirat");
  napi_value output;
  napi_get_undefined(env, &output);
  return output;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  int32_t source_dirfd = -1;
  int32_t destination_dirfd = -1;
  int32_t mode = -1;
  char source[NAME_MAX + 1];
  char destination[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 5) {
    napi_throw_type_error(
        env, "EINVAL",
        "renameAt requires two dirfds, two names, and a rename mode");
    return NULL;
  }
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "source dirfd",
                         &source_dirfd) ||
      !get_entry_name(env, argv[1], source) ||
      !get_bounded_int32(env, argv[2], 0, INT32_MAX, "destination dirfd",
                         &destination_dirfd) ||
      !get_entry_name(env, argv[3], destination) ||
      !get_bounded_int32(env, argv[4], 0, 2, "rename mode", &mode))
    return NULL;
  unsigned int flags = 0;
  if (mode == 1)
    flags = RENAME_EXCL;
  else if (mode == 2)
    flags = RENAME_SWAP;
  if (renameatx_np(source_dirfd, source, destination_dirfd, destination,
                   flags) != 0)
    return throw_errno(env, errno, "renameatx_np");
  napi_value output;
  napi_get_undefined(env, &output);
  return output;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t dirfd = -1;
  bool directory = false;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 3) {
    napi_throw_type_error(env, "EINVAL",
                          "unlinkAt requires dirfd, name, and directory flag");
    return NULL;
  }
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name) ||
      !get_boolean(env, argv[2], "directory", &directory))
    return NULL;
  if (unlinkat(dirfd, name, directory ? AT_REMOVEDIR : 0) != 0)
    return throw_errno(env, errno, "unlinkat");
  napi_value output;
  napi_get_undefined(env, &output);
  return output;
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t dirfd = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 ||
      !get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd)) {
    if (argc != 1)
      napi_throw_type_error(env, "EINVAL", "readDirectory requires dirfd");
    return NULL;
  }
  int duplicated = fcntl(dirfd, F_DUPFD_CLOEXEC, 0);
  if (duplicated < 0)
    return throw_errno(env, errno, "duplicate directory descriptor");
  DIR *directory = fdopendir(duplicated);
  if (directory == NULL) {
    int saved_errno = errno;
    close(duplicated);
    return throw_errno(env, saved_errno, "fdopendir");
  }
  rewinddir(directory);
  napi_value output;
  if (napi_create_array(env, &output) != napi_ok) {
    closedir(directory);
    napi_throw_error(env, "EIO", "failed to create directory entry array");
    return NULL;
  }
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) !=
            napi_ok ||
        napi_set_element(env, output, index++, name) != napi_ok) {
      closedir(directory);
      napi_throw_error(env, "EIO", "failed to return directory entries");
      return NULL;
    }
  }
  int read_errno = errno;
  if (closedir(directory) != 0 && read_errno == 0)
    read_errno = errno;
  if (read_errno != 0)
    return throw_errno(env, read_errno, "readdir");
#ifdef WORKSPACE_SPARSE_DIRECTORY
  if (napi_set_element(env, output, index + 1, output) != napi_ok) {
    napi_throw_error(env, "EIO", "failed to create sparse directory result");
    return NULL;
  }
#endif
  return output;
}

static napi_value duplicate_descriptor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t descriptor = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || !get_bounded_int32(env, argv[0], 0, INT32_MAX, "descriptor",
                                      &descriptor)) {
    if (argc != 1)
      napi_throw_type_error(env, "EINVAL", "duplicateDescriptor requires descriptor");
    return NULL;
  }
  int duplicated = fcntl(descriptor, F_DUPFD_CLOEXEC, 0);
  if (duplicated < 0)
    return throw_errno(env, errno, "duplicate descriptor");
  return descriptor_value(env, duplicated);
}

#ifndef WORKSPACE_OMIT_STAT_AT
static void set_number(napi_env env, napi_value target, const char *name,
                       double value) {
  napi_value property;
  napi_create_double(env, value, &property);
  napi_set_named_property(env, target, name, property);
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int32_t dirfd = -1;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2) {
    napi_throw_type_error(env, "EINVAL", "statAt requires dirfd and name");
    return NULL;
  }
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name))
    return NULL;
  struct stat value;
  if (fstatat(dirfd, name, &value, AT_SYMLINK_NOFOLLOW) != 0)
    return throw_errno(env, errno, "fstatat");
  napi_value output;
  napi_create_object(env, &output);
  set_number(env, output, "dev", (double)value.st_dev);
  set_number(env, output, "ino", (double)value.st_ino);
  set_number(env, output, "mode", (double)value.st_mode);
  set_number(env, output, "size", (double)value.st_size);
  double modified = (double)value.st_mtimespec.tv_sec * 1000.0 +
                    (double)value.st_mtimespec.tv_nsec / 1000000.0;
  set_number(env, output, "mtimeMs", modified);
  return output;
}
#endif

static void set_string(napi_env env, napi_value target, const char *name,
                       const char *value) {
  napi_value property;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &property);
  napi_set_named_property(env, target, name, property);
}

static void set_int32(napi_env env, napi_value target, const char *name,
                      int32_t value) {
  napi_value property;
  napi_create_int32(env, value, &property);
  napi_set_named_property(env, target, name, property);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
      {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
      {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
      {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
      {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
      {"readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default,
       NULL},
      {"duplicateDescriptor", NULL, duplicate_descriptor, NULL, NULL, NULL,
       napi_default, NULL},
#ifndef WORKSPACE_OMIT_STAT_AT
      {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
#endif
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]),
                         methods);
  set_int32(env, exports, "apiVersion", 1);
  set_int32(env, exports, "abiVersion", WORKSPACE_ABI_VERSION);
  set_string(env, exports, "platform", "darwin");
  set_string(env, exports, "resolution", "dirfd-relative");
  set_string(env, exports, "adapter", "workspace-safe-fs");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
