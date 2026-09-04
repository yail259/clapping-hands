# frozen_string_literal: true

require "json"

USERNAME = "benchmark-admin"
EMAIL = "benchmark-admin@example.invalid"
TOPIC_PREFIX = "Clapping Hands Benchmark"

def benchmark_user
  User.find_by(username: USERNAME) || raise("Synthetic Discourse user is missing; run seed first")
end

def topic_snapshot(title)
  topics = Topic.with_deleted.where(title: title).order(:id).to_a
  {
    count: topics.count { |topic| topic.deleted_at.nil? },
    topics: topics.map do |topic|
      {
        id: topic.id,
        title: topic.title,
        slug: topic.slug,
        deleted: !topic.deleted_at.nil?,
        raw: topic.first_post_with_deleted&.raw,
        postVersion: topic.first_post_with_deleted&.version,
      }
    end,
  }
end

def permanently_remove_topic(topic)
  first_post = topic.first_post_with_deleted
  PostDestroyer.new(Discourse.system_user, first_post, context: "Clapping Hands synthetic fixture cleanup").destroy if first_post
  Topic.with_deleted.find_by(id: topic.id)&.destroy!
end

command = ENV.fetch("CH_DISCOURSE_COMMAND", "inspect")
result =
  case command
  when "seed"
    password = ENV.fetch("CH_DISCOURSE_PASSWORD")
    raise "Synthetic password must be at least 12 characters" if password.length < 12

    user = User.find_or_initialize_by(username: USERNAME)
    user.email = EMAIL
    user.name = "Clapping Hands Benchmark Admin"
    user.password = password unless user.persisted? && user.confirm_password?(password)
    user.active = true
    user.approved = true
    user.save!
    user.grant_admin!
    user.grant_moderation!
    user.change_trust_level!(4)
    user.email_tokens.update_all(confirmed: true)
    user.activate

    SiteSetting.title = "Clapping Hands Discourse Fixture"
    SiteSetting.short_site_description = "Synthetic loopback-only benchmark forum"
    SiteSetting.wizard_enabled = false
    SiteSetting.disable_emails = "yes"

    categories = [
      ["Clapping Alpha", "A1B2C3"],
      ["Clapping Beta", "3C4D5E"],
      ["Clapping Gamma", "5E6F70"],
    ].map do |name, color|
      category = Category.find_or_initialize_by(name: name)
      category.user = user
      category.color = color
      category.text_color = "FFFFFF"
      category.save!
      category
    end

    topics = [
      ["#{TOPIC_PREFIX} Alpha Router", "Synthetic alpha routing body."],
      ["#{TOPIC_PREFIX} Beta Cache", "Synthetic beta caching body."],
      ["#{TOPIC_PREFIX} Gamma Compiler", "Synthetic gamma compilation body."],
    ].each_with_index.map do |(title, raw), index|
      existing = Topic.with_deleted.find_by(title: title)
      permanently_remove_topic(existing) if existing
      post = PostCreator.create!(
        user,
        title: title,
        raw: raw,
        category: categories.fetch(index).id,
        skip_validations: true,
      )
      { id: post.topic_id, title: title, raw: raw, categoryId: categories.fetch(index).id }
    end
    Draft.where(user_id: user.id).destroy_all
    Category.update_stats
    { userId: user.id, categories: categories.map { |category| { id: category.id, name: category.name, slug: category.slug } }, topics: topics }
  when "topic"
    topic_snapshot(ENV.fetch("CH_DISCOURSE_TOPIC_TITLE"))
  when "remove-topic"
    title = ENV.fetch("CH_DISCOURSE_TOPIC_TITLE")
    Topic.with_deleted.where(title: title).find_each { |topic| permanently_remove_topic(topic) }
    topic_snapshot(title)
  when "reset-topic"
    title = ENV.fetch("CH_DISCOURSE_TOPIC_TITLE")
    raw = ENV.fetch("CH_DISCOURSE_TOPIC_BODY")
    topic = Topic.find_by!(title: title)
    topic.first_post.revise(benchmark_user, { raw: raw }, skip_validations: true)
    topic_snapshot(title)
  when "drafts"
    drafts = Draft.where(user_id: benchmark_user.id).order(:id)
    { count: drafts.count, keys: drafts.pluck(:draft_key) }
  when "clear-drafts"
    Draft.where(user_id: benchmark_user.id).destroy_all
    { count: Draft.where(user_id: benchmark_user.id).count }
  when "inspect"
    {
      userId: benchmark_user.id,
      topicCount: Topic.where("title LIKE ?", "#{TOPIC_PREFIX}%").count,
      draftCount: Draft.where(user_id: benchmark_user.id).count,
    }
  else
    raise "Unsupported fixture command: #{command}"
  end

puts "CH_JSON=#{JSON.generate(result)}"
