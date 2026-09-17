import { useTranslation } from "react-i18next";
import { resolveSupportedLocale, type SupportedLocale } from "@/i18n/locales";

/**
 * Collaboration chrome is translated here so this workstream does not edit the app-wide
 * i18n resources. Product nouns such as Workspace stay in English, matching existing locales.
 */
export interface CollabCopy {
  share: {
    title: string;
    subtitle: string;
    principalLabel: string;
    principalPlaceholder: string;
    principalInvalid: string;
    principalSelf: string;
    principalOwner: string;
    roleLabel: string;
    add: string;
    adding: string;
    members: string;
    you: string;
    remove: string;
    removeTitle: string;
    removeMessage: string;
    confirmRemove: string;
    cancel: string;
    close: string;
    revoked: string;
    failed: string;
    readOnly: string;
    collaborationOff: string;
    enable: string;
    enabling: string;
    enableHint: string;
    enableFailed: string;
  };
  presence: {
    title: string;
    empty: string;
    you: string;
  };
  author: {
    you: string;
  };
  queued: {
    yours: string;
    one: string;
    many: string;
  };
  revoke: {
    title: string;
    membershipRemoved: string;
    generic: string;
  };
  roles: {
    owner: string;
    editor: string;
    viewer: string;
  };
}

const en: CollabCopy = {
  share: {
    title: "Share workspace",
    subtitle: "People in this workspace can see its sessions.",
    principalLabel: "Person",
    principalPlaceholder: "usr_",
    principalInvalid: "Enter a person ID",
    principalSelf: "You are already in this workspace",
    principalOwner: "The owner cannot be added as a member",
    roleLabel: "Role",
    add: "Add",
    adding: "Adding…",
    members: "Members",
    you: "You",
    remove: "Remove",
    removeTitle: "Remove this person?",
    removeMessage: "{{name}} will lose access to this workspace.",
    confirmRemove: "Remove",
    cancel: "Cancel",
    close: "Close",
    revoked: "This workspace is no longer shared with you.",
    failed: "Unable to update members",
    readOnly: "Only the owner can add or remove people.",
    collaborationOff: "Sharing is not turned on for this workspace.",
    enable: "Turn on sharing",
    enabling: "Turning on…",
    enableHint: "Turn on sharing to add people to this workspace.",
    enableFailed: "Unable to turn on sharing",
  },
  presence: {
    title: "Here now",
    empty: "Nobody else is here",
    you: "You",
  },
  author: {
    you: "You",
  },
  queued: {
    yours: "Your message is waiting",
    one: "{{name}} is waiting",
    many: "{{count}} messages waiting",
  },
  revoke: {
    title: "Access removed",
    membershipRemoved: "You no longer have access to this workspace.",
    generic: "This workspace is no longer available.",
  },
  roles: {
    owner: "Owner",
    editor: "Editor",
    viewer: "Viewer",
  },
};

const ar: CollabCopy = {
  share: {
    title: "مشاركة Workspace",
    subtitle: "يمكن للأشخاص في هذا Workspace رؤية جلساته.",
    principalLabel: "شخص",
    principalPlaceholder: "usr_",
    principalInvalid: "أدخل معرّف الشخص",
    principalSelf: "أنت موجود بالفعل في هذا Workspace",
    principalOwner: "لا يمكن إضافة المالك كعضو",
    roleLabel: "الدور",
    add: "إضافة",
    adding: "جارٍ الإضافة…",
    members: "الأعضاء",
    you: "أنت",
    remove: "إزالة",
    removeTitle: "إزالة هذا الشخص؟",
    removeMessage: "سيفقد {{name}} الوصول إلى هذا Workspace.",
    confirmRemove: "إزالة",
    cancel: "إلغاء",
    close: "إغلاق",
    revoked: "لم يعد هذا Workspace مشتركاً معك.",
    failed: "تعذر تحديث الأعضاء",
    readOnly: "المالك وحده يمكنه إضافة الأشخاص أو إزالتهم.",
    collaborationOff: "المشاركة غير مفعّلة لهذا Workspace.",
    enable: "تفعيل المشاركة",
    enabling: "جارٍ التفعيل…",
    enableHint: "فعّل المشاركة لإضافة أشخاص إلى هذا Workspace.",
    enableFailed: "تعذر تفعيل المشاركة",
  },
  presence: {
    title: "المتواجدون الآن",
    empty: "لا يوجد أحد آخر هنا",
    you: "أنت",
  },
  author: {
    you: "أنت",
  },
  queued: {
    yours: "رسالتك في الانتظار",
    one: "{{name}} ينتظر",
    many: "{{count}} رسائل في الانتظار",
  },
  revoke: {
    title: "أُزيل الوصول",
    membershipRemoved: "لم يعد لديك وصول إلى هذا Workspace.",
    generic: "هذا Workspace لم يعد متاحاً.",
  },
  roles: {
    owner: "مالك",
    editor: "محرر",
    viewer: "عارض",
  },
};

const es: CollabCopy = {
  share: {
    title: "Compartir workspace",
    subtitle: "Las personas de este workspace pueden ver sus sesiones.",
    principalLabel: "Persona",
    principalPlaceholder: "usr_",
    principalInvalid: "Introduce un ID de persona",
    principalSelf: "Ya estás en este workspace",
    principalOwner: "El propietario no puede añadirse como miembro",
    roleLabel: "Rol",
    add: "Añadir",
    adding: "Añadiendo…",
    members: "Miembros",
    you: "Tú",
    remove: "Quitar",
    removeTitle: "¿Quitar a esta persona?",
    removeMessage: "{{name}} perderá el acceso a este workspace.",
    confirmRemove: "Quitar",
    cancel: "Cancelar",
    close: "Cerrar",
    revoked: "Este workspace ya no se comparte contigo.",
    failed: "No se pudieron actualizar los miembros",
    readOnly: "Solo el propietario puede añadir o quitar personas.",
    collaborationOff: "El uso compartido no está activado en este workspace.",
    enable: "Activar uso compartido",
    enabling: "Activando…",
    enableHint: "Activa el uso compartido para añadir personas a este workspace.",
    enableFailed: "No se pudo activar el uso compartido",
  },
  presence: {
    title: "Ahora aquí",
    empty: "No hay nadie más aquí",
    you: "Tú",
  },
  author: {
    you: "Tú",
  },
  queued: {
    yours: "Tu mensaje está en espera",
    one: "{{name}} está en espera",
    many: "{{count}} mensajes en espera",
  },
  revoke: {
    title: "Acceso retirado",
    membershipRemoved: "Ya no tienes acceso a este workspace.",
    generic: "Este workspace ya no está disponible.",
  },
  roles: {
    owner: "Propietario",
    editor: "Editor",
    viewer: "Lector",
  },
};

const fr: CollabCopy = {
  share: {
    title: "Partager le workspace",
    subtitle: "Les personnes de ce workspace peuvent voir ses sessions.",
    principalLabel: "Personne",
    principalPlaceholder: "usr_",
    principalInvalid: "Saisissez un identifiant de personne",
    principalSelf: "Vous êtes déjà dans ce workspace",
    principalOwner: "Le propriétaire ne peut pas être ajouté comme membre",
    roleLabel: "Rôle",
    add: "Ajouter",
    adding: "Ajout…",
    members: "Membres",
    you: "Vous",
    remove: "Retirer",
    removeTitle: "Retirer cette personne ?",
    removeMessage: "{{name}} perdra l’accès à ce workspace.",
    confirmRemove: "Retirer",
    cancel: "Annuler",
    close: "Fermer",
    revoked: "Ce workspace n’est plus partagé avec vous.",
    failed: "Impossible de mettre à jour les membres",
    readOnly: "Seul le propriétaire peut ajouter ou retirer des personnes.",
    collaborationOff: "Le partage n’est pas activé pour ce workspace.",
    enable: "Activer le partage",
    enabling: "Activation…",
    enableHint: "Activez le partage pour ajouter des personnes à ce workspace.",
    enableFailed: "Impossible d’activer le partage",
  },
  presence: {
    title: "Présents",
    empty: "Personne d’autre n’est là",
    you: "Vous",
  },
  author: {
    you: "Vous",
  },
  queued: {
    yours: "Votre message est en attente",
    one: "{{name}} est en attente",
    many: "{{count}} messages en attente",
  },
  revoke: {
    title: "Accès retiré",
    membershipRemoved: "Vous n’avez plus accès à ce workspace.",
    generic: "Ce workspace n’est plus disponible.",
  },
  roles: {
    owner: "Propriétaire",
    editor: "Éditeur",
    viewer: "Lecteur",
  },
};

const ja: CollabCopy = {
  share: {
    title: "Workspace を共有",
    subtitle: "この Workspace のメンバーはそのセッションを見られます。",
    principalLabel: "人",
    principalPlaceholder: "usr_",
    principalInvalid: "人の ID を入力してください",
    principalSelf: "あなたはすでにこの Workspace にいます",
    principalOwner: "オーナーをメンバーとして追加できません",
    roleLabel: "役割",
    add: "追加",
    adding: "追加中…",
    members: "メンバー",
    you: "自分",
    remove: "削除",
    removeTitle: "この人を削除しますか？",
    removeMessage: "{{name}} はこの Workspace にアクセスできなくなります。",
    confirmRemove: "削除",
    cancel: "キャンセル",
    close: "閉じる",
    revoked: "この Workspace はもうあなたと共有されていません。",
    failed: "メンバーを更新できません",
    readOnly: "追加と削除ができるのはオーナーだけです。",
    collaborationOff: "この Workspace では共有がオンになっていません。",
    enable: "共有をオンにする",
    enabling: "オンにしています…",
    enableHint: "共有をオンにすると、この Workspace に人を追加できます。",
    enableFailed: "共有をオンにできません",
  },
  presence: {
    title: "いまここにいる人",
    empty: "ほかに誰もいません",
    you: "自分",
  },
  author: {
    you: "自分",
  },
  queued: {
    yours: "メッセージは待機中です",
    one: "{{name}} が待機中",
    many: "{{count}} 件のメッセージが待機中",
  },
  revoke: {
    title: "アクセスが削除されました",
    membershipRemoved: "この Workspace にアクセスできなくなりました。",
    generic: "この Workspace は利用できません。",
  },
  roles: {
    owner: "オーナー",
    editor: "編集者",
    viewer: "閲覧者",
  },
};

const ko: CollabCopy = {
  share: {
    title: "Workspace 공유",
    subtitle: "이 Workspace의 사람들은 세션을 볼 수 있습니다.",
    principalLabel: "사람",
    principalPlaceholder: "usr_",
    principalInvalid: "사람 ID를 입력하세요",
    principalSelf: "이미 이 Workspace에 있습니다",
    principalOwner: "소유자는 멤버로 추가할 수 없습니다",
    roleLabel: "역할",
    add: "추가",
    adding: "추가 중…",
    members: "멤버",
    you: "나",
    remove: "제거",
    removeTitle: "이 사람을 제거할까요?",
    removeMessage: "{{name}}은(는) 이 Workspace에 접근할 수 없게 됩니다.",
    confirmRemove: "제거",
    cancel: "취소",
    close: "닫기",
    revoked: "이 Workspace는 더 이상 나와 공유되지 않습니다.",
    failed: "멤버를 업데이트할 수 없습니다",
    readOnly: "소유자만 사람을 추가하거나 제거할 수 있습니다.",
    collaborationOff: "이 Workspace에서는 공유가 켜져 있지 않습니다.",
    enable: "공유 켜기",
    enabling: "켜는 중…",
    enableHint: "공유를 켜면 이 Workspace에 사람을 추가할 수 있습니다.",
    enableFailed: "공유를 켤 수 없습니다",
  },
  presence: {
    title: "지금 여기",
    empty: "다른 사람은 없습니다",
    you: "나",
  },
  author: {
    you: "나",
  },
  queued: {
    yours: "메시지가 대기 중입니다",
    one: "{{name}} 님이 대기 중",
    many: "메시지 {{count}}개가 대기 중",
  },
  revoke: {
    title: "접근이 제거됨",
    membershipRemoved: "더 이상 이 Workspace에 접근할 수 없습니다.",
    generic: "이 Workspace를 더 이상 사용할 수 없습니다.",
  },
  roles: {
    owner: "소유자",
    editor: "편집자",
    viewer: "뷰어",
  },
};

const ptBR: CollabCopy = {
  share: {
    title: "Compartilhar workspace",
    subtitle: "As pessoas neste workspace podem ver as sessões dele.",
    principalLabel: "Pessoa",
    principalPlaceholder: "usr_",
    principalInvalid: "Informe o ID da pessoa",
    principalSelf: "Você já está neste workspace",
    principalOwner: "O proprietário não pode ser adicionado como membro",
    roleLabel: "Função",
    add: "Adicionar",
    adding: "Adicionando…",
    members: "Membros",
    you: "Você",
    remove: "Remover",
    removeTitle: "Remover esta pessoa?",
    removeMessage: "{{name}} perderá o acesso a este workspace.",
    confirmRemove: "Remover",
    cancel: "Cancelar",
    close: "Fechar",
    revoked: "Este workspace não é mais compartilhado com você.",
    failed: "Não foi possível atualizar os membros",
    readOnly: "Só o proprietário pode adicionar ou remover pessoas.",
    collaborationOff: "O compartilhamento não está ativado neste workspace.",
    enable: "Ativar compartilhamento",
    enabling: "Ativando…",
    enableHint: "Ative o compartilhamento para adicionar pessoas a este workspace.",
    enableFailed: "Não foi possível ativar o compartilhamento",
  },
  presence: {
    title: "Aqui agora",
    empty: "Não há mais ninguém aqui",
    you: "Você",
  },
  author: {
    you: "Você",
  },
  queued: {
    yours: "Sua mensagem está na fila",
    one: "{{name}} está na fila",
    many: "{{count}} mensagens na fila",
  },
  revoke: {
    title: "Acesso removido",
    membershipRemoved: "Você não tem mais acesso a este workspace.",
    generic: "Este workspace não está mais disponível.",
  },
  roles: {
    owner: "Proprietário",
    editor: "Editor",
    viewer: "Leitor",
  },
};

const ru: CollabCopy = {
  share: {
    title: "Открыть доступ к workspace",
    subtitle: "Люди в этом workspace видят его сессии.",
    principalLabel: "Человек",
    principalPlaceholder: "usr_",
    principalInvalid: "Введите идентификатор человека",
    principalSelf: "Вы уже в этом workspace",
    principalOwner: "Владельца нельзя добавить как участника",
    roleLabel: "Роль",
    add: "Добавить",
    adding: "Добавление…",
    members: "Участники",
    you: "Вы",
    remove: "Удалить",
    removeTitle: "Удалить этого человека?",
    removeMessage: "{{name}} потеряет доступ к этому workspace.",
    confirmRemove: "Удалить",
    cancel: "Отмена",
    close: "Закрыть",
    revoked: "Этот workspace больше не открыт для вас.",
    failed: "Не удалось обновить участников",
    readOnly: "Добавлять и удалять людей может только владелец.",
    collaborationOff: "Общий доступ для этого workspace не включён.",
    enable: "Включить общий доступ",
    enabling: "Включение…",
    enableHint: "Включите общий доступ, чтобы добавлять людей в этот workspace.",
    enableFailed: "Не удалось включить общий доступ",
  },
  presence: {
    title: "Сейчас здесь",
    empty: "Кроме вас никого нет",
    you: "Вы",
  },
  author: {
    you: "Вы",
  },
  queued: {
    yours: "Ваше сообщение ожидает",
    one: "{{name}} ожидает",
    many: "{{count}} сообщений ожидают",
  },
  revoke: {
    title: "Доступ отозван",
    membershipRemoved: "У вас больше нет доступа к этому workspace.",
    generic: "Этот workspace больше недоступен.",
  },
  roles: {
    owner: "Владелец",
    editor: "Редактор",
    viewer: "Читатель",
  },
};

const zhCN: CollabCopy = {
  share: {
    title: "共享 Workspace",
    subtitle: "此 Workspace 中的人可以看到它的会话。",
    principalLabel: "人员",
    principalPlaceholder: "usr_",
    principalInvalid: "请输入人员 ID",
    principalSelf: "你已在此 Workspace 中",
    principalOwner: "不能把所有者添加为成员",
    roleLabel: "角色",
    add: "添加",
    adding: "正在添加…",
    members: "成员",
    you: "你",
    remove: "移除",
    removeTitle: "移除此人？",
    removeMessage: "{{name}} 将失去对此 Workspace 的访问权限。",
    confirmRemove: "移除",
    cancel: "取消",
    close: "关闭",
    revoked: "此 Workspace 已不再与你共享。",
    failed: "无法更新成员",
    readOnly: "只有所有者可以添加或移除人员。",
    collaborationOff: "此 Workspace 尚未开启共享。",
    enable: "开启共享",
    enabling: "正在开启…",
    enableHint: "开启共享后，才能把人加入此 Workspace。",
    enableFailed: "无法开启共享",
  },
  presence: {
    title: "此刻在此",
    empty: "没有其他人在",
    you: "你",
  },
  author: {
    you: "你",
  },
  queued: {
    yours: "你的消息正在等待",
    one: "{{name}} 正在等待",
    many: "{{count}} 条消息正在等待",
  },
  revoke: {
    title: "访问已移除",
    membershipRemoved: "你不再拥有此 Workspace 的访问权限。",
    generic: "此 Workspace 已不可用。",
  },
  roles: {
    owner: "所有者",
    editor: "编辑者",
    viewer: "查看者",
  },
};

export const COLLAB_COPY: Record<SupportedLocale, CollabCopy> = {
  ar,
  en,
  es,
  fr,
  ja,
  ko,
  "pt-BR": ptBR,
  ru,
  "zh-CN": zhCN,
};

export function collabCopyFor(language: string | undefined): CollabCopy {
  const locale = resolveSupportedLocale("system", language ? [language] : []);
  return COLLAB_COPY[locale];
}

export function formatCollabCopy(
  template: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}

export function useCollabCopy(): CollabCopy {
  const { i18n } = useTranslation();
  return collabCopyFor(i18n.resolvedLanguage ?? i18n.language);
}
