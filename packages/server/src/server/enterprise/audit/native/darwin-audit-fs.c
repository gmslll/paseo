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
#include <unistd.h>

#ifndef O_NOFOLLOW
#error "Darwin audit storage requires O_NOFOLLOW"
#endif

#ifndef O_CLOEXEC
#error "Darwin audit storage requires O_CLOEXEC"
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
  case ELOOP:
    return "ELOOP";
  case ENAMETOOLONG:
    return "ENAMETOOLONG";
  case ENOENT:
    return "ENOENT";
  case ENOTDIR:
    return "ENOTDIR";
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

static bool get_open_flags(napi_env env, napi_value value, int32_t *output) {
  if (!get_bounded_int32(env, value, 0, INT32_MAX, "flags", output))
    return false;
  const int32_t allowed =
      O_ACCMODE | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC;
  const int32_t access = *output & O_ACCMODE;
  if ((*output & ~allowed) != 0 || (access != O_RDONLY && access != O_RDWR) ||
      ((*output & O_EXCL) != 0 && (*output & O_CREAT) == 0)) {
    napi_throw_type_error(env, "EINVAL", "invalid audit open flags");
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
    napi_throw_type_error(env, "EINVAL", "invalid audit open mode");
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

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 4) {
    napi_throw_type_error(env, "EINVAL",
                          "openAt requires dirfd, name, flags, and mode");
    return NULL;
  }

  int32_t dirfd = -1;
  int32_t flags = 0;
  int32_t mode = 0;
  char name[NAME_MAX + 1];
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name) ||
      !get_open_flags(env, argv[2], &flags) ||
      !get_open_mode(env, argv[3], flags, &mode)) {
    return NULL;
  }

  // The native trust boundary enforces both flags even when a JS caller omits
  // them.
  flags |= O_NOFOLLOW | O_CLOEXEC;
  int result = openat(dirfd, name, flags, (mode_t)mode);
  if (result < 0)
    return throw_errno(env, errno, "openat");

  napi_value output;
  if (napi_create_int32(env, result, &output) != napi_ok) {
    close(result);
    napi_throw_error(env, "EIO", "failed to return openat descriptor");
    return NULL;
  }
  return output;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 3) {
    napi_throw_type_error(env, "EINVAL",
                          "renameAt requires dirfd and two names");
    return NULL;
  }

  int32_t dirfd = -1;
  char source[NAME_MAX + 1];
  char destination[NAME_MAX + 1];
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], source) ||
      !get_entry_name(env, argv[2], destination)) {
    return NULL;
  }
  if (renameat(dirfd, source, dirfd, destination) != 0) {
    return throw_errno(env, errno, "renameat");
  }
  napi_value output;
  napi_get_undefined(env, &output);
  return output;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2) {
    napi_throw_type_error(env, "EINVAL", "unlinkAt requires dirfd and name");
    return NULL;
  }

  int32_t dirfd = -1;
  char name[NAME_MAX + 1];
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd) ||
      !get_entry_name(env, argv[1], name))
    return NULL;
  if (unlinkat(dirfd, name, 0) != 0)
    return throw_errno(env, errno, "unlinkat");
  napi_value output;
  napi_get_undefined(env, &output);
  return output;
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1) {
    napi_throw_type_error(env, "EINVAL", "readDirectory requires dirfd");
    return NULL;
  }
  int32_t dirfd = -1;
  if (!get_bounded_int32(env, argv[0], 0, INT32_MAX, "dirfd", &dirfd))
    return NULL;

  int duplicated = dup(dirfd);
  if (duplicated < 0)
    return throw_errno(env, errno, "dup");
#ifdef FD_CLOEXEC
  if (fcntl(duplicated, F_SETFD, FD_CLOEXEC) != 0) {
    int saved_errno = errno;
    close(duplicated);
    return throw_errno(env, saved_errno, "fcntl");
  }
#endif
  DIR *directory = fdopendir(duplicated);
  if (directory == NULL) {
    int saved_errno = errno;
    close(duplicated);
    return throw_errno(env, saved_errno, "fdopendir");
  }
  rewinddir(directory);

  napi_value output;
  if (napi_create_array(env, &output) != napi_ok) {
    int close_result = closedir(directory);
    if (close_result != 0)
      return throw_errno(env, errno, "closedir");
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
  return output;
}

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
      {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
      {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
      {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
      {"readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default,
       NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]),
                         methods);
  set_int32(env, exports, "apiVersion", 1);
  set_string(env, exports, "platform", "darwin");
  set_string(env, exports, "resolution", "dirfd-relative");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
