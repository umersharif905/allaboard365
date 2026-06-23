import ShareRequestNew from '../../../../pages/vendor/ShareRequestNew';

interface MemberNewRequestTabProps {
  memberId: string;
}

// Renders the share request creation form inline inside the Members workspace tab,
// pre-selecting the active member so operators can file a request without leaving
// the member context.
const MemberNewRequestTab = ({ memberId }: MemberNewRequestTabProps) => (
  <ShareRequestNew embeddedMemberId={memberId} />
);

export default MemberNewRequestTab;
